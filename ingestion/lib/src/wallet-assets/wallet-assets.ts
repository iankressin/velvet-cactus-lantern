import { readFileSync } from "node:fs";
import { isAddress as isSolanaAddress, type Address as SolanaAddress } from "@solana/kit";
import { isAddress as isEvmAddress, type Address as EvmAddress } from "viem";
import { bitcoinAddress, type BitcoinAddress } from "#src/bitcoin/address.ts";
import { toLower } from "#src/evm/address.ts";
import { logger } from "#src/logger.ts";
import { parseCsv, type CsvRow } from "#src/wallet-assets/csv.ts";

/** One wallet and one asset whose balance a run reads. A native asset has no token address. */
export type WalletAsset =
  | { blockchain: "ethereum"; assetType: "native"; walletAddress: EvmAddress; tokenAddress: null }
  | { blockchain: "ethereum"; assetType: "erc20"; walletAddress: EvmAddress; tokenAddress: EvmAddress }
  | { blockchain: "solana"; assetType: "native"; walletAddress: SolanaAddress; tokenAddress: null }
  | { blockchain: "solana"; assetType: "spl"; walletAddress: SolanaAddress; tokenAddress: SolanaAddress }
  | { blockchain: "bitcoin"; assetType: "native"; walletAddress: BitcoinAddress; tokenAddress: null };

export type Blockchain = WalletAsset["blockchain"];

// Built as a plain object type first: TypeScript cannot match a generic T to its constraint when the
// constraint indexes Extract<WalletAsset, ...> directly.
type AssetTypes = { [B in Blockchain]: Extract<WalletAsset, { blockchain: B }>["assetType"] };

/** The asset types a chain has: its native asset and its token standard, if any. */
export type AssetType<B extends Blockchain = Blockchain> = AssetTypes[B];

type Picked<B extends Blockchain, T extends AssetType<B>> = Extract<WalletAsset, { blockchain: B; assetType: T }>;

type ChainRules = {
  /** How messages name an address on the chain. */
  noun: string;
  /** The native asset, which an empty token_address stands for. */
  symbol: string;
  /** The asset type of the chain's tokens, or null on a chain without tokens. */
  tokenType: AssetType | null;
  /** The address as the raw tables store it, or null when `value` is not an address on the chain. */
  address(value: string): string | null;
};

const chains: Record<Blockchain, ChainRules> = {
  ethereum: {
    noun: "an Ethereum address",
    symbol: "ETH",
    tokenType: "erc20",
    address: (value) => (isEvmAddress(value) ? toLower(value) : null),
  },
  solana: {
    noun: "a Solana address",
    symbol: "SOL",
    tokenType: "spl",
    address: (value) => (isSolanaAddress(value) ? value : null),
  },
  bitcoin: {
    noun: "a Bitcoin address",
    symbol: "BTC",
    tokenType: null,
    address: (value) => bitcoinAddress.safeParse(value).data ?? null,
  },
};

const isBlockchain = (value: string | undefined): value is Blockchain =>
  value !== undefined && Object.hasOwn(chains, value);

/** Native when token_address is empty or missing, else the chain's token type: null on a chain without tokens. */
const assetTypeOf = (blockchain: Blockchain, row: CsvRow) =>
  row.record.tokenAddress ? chains[blockchain].tokenType : "native";

/**
 * Whether a read of `blockchain`, and of `assetType` when given, takes the row. A token row on a
 * chain without tokens counts as part of every read of that chain, so its error reaches that chain's source.
 */
function picks(row: CsvRow, blockchain: Blockchain, assetType: AssetType | undefined): boolean {
  if (row.record.blockchain !== blockchain) return false;
  const type = assetTypeOf(blockchain, row);
  return assetType === undefined || type === null || type === assetType;
}

/** What is wrong with a picked row, in the words of the person who fixes the file. */
function problemsWith(blockchain: Blockchain, row: CsvRow, columnCount: number): string[] {
  // A short or long row's cells may sit under the wrong columns, so nothing else about it is checked.
  if (row.cellCount !== columnCount) return [`has ${row.cellCount} cells; the header has ${columnCount}`];

  const chain = chains[blockchain];
  const { walletAddress = "", tokenAddress = "" } = row.record;
  const problems: string[] = [];
  if (chain.address(walletAddress) === null) {
    problems.push(`wallet_address "${walletAddress}" is not ${chain.noun}`);
  }
  if (tokenAddress && chain.tokenType === null) {
    problems.push(`${blockchain} has no tokens; leave token_address empty`);
  } else if (tokenAddress && chain.address(tokenAddress) === null) {
    problems.push(`token_address "${tokenAddress}" is not ${chain.noun}; leave it empty for ${chain.symbol}`);
  }
  return problems;
}

/** A valid row's wallet asset, its addresses in the form the raw tables store. */
function walletAssetOf(blockchain: Blockchain, row: CsvRow): WalletAsset {
  const chain = chains[blockchain];
  const token = row.record.tokenAddress;
  // The chain's table stands behind each address, which the union's types cannot see.
  return {
    blockchain,
    assetType: assetTypeOf(blockchain, row),
    walletAddress: chain.address(row.record.walletAddress ?? ""),
    tokenAddress: token ? chain.address(token) : null,
  } as WalletAsset;
}

/**
 * The wallet assets in CSV text on `blockchain`, of `assetType` when given. `file` names the input in
 * errors. Only the rows this read picks can fail it. Rows on an unknown chain, which no read picks, and
 * repeated rows go to `warn`.
 */
export function parseWalletAssets<B extends Blockchain, T extends AssetType<B> = AssetType<B>>(
  text: string,
  file: string,
  blockchain: B,
  assetType?: T,
  warn: (message: string) => void = (message) => logger.warn(message),
): Picked<B, T>[] {
  const { columns, rows } = parseCsv(text, file, ["blockchain", "wallet_address", "token_address"]);

  const unread = rows
    .filter((row) => !isBlockchain(row.record.blockchain))
    .map((row) => `  line ${row.line}: blockchain "${row.record.blockchain ?? ""}" is not ethereum, solana or bitcoin`);
  if (unread.length > 0) warn(`Rows in ${file} that no source reads:\n${unread.join("\n")}`);

  const picked = rows.filter((row) => picks(row, blockchain, assetType));
  const problems = picked.flatMap((row) =>
    problemsWith(blockchain, row, columns.length).map((problem) => `  line ${row.line}: ${problem}`),
  );
  if (problems.length > 0) {
    const read = assetType === undefined ? blockchain : `${blockchain} ${assetType}`;
    throw new Error(`Invalid ${read} rows in ${file}:\n${problems.join("\n")}`);
  }

  const firstLines = new Map<string, number>();
  const assets: WalletAsset[] = [];
  const repeats: string[] = [];
  for (const row of picked) {
    const asset = walletAssetOf(blockchain, row);
    const key = `${asset.walletAddress}:${asset.tokenAddress ?? ""}`;
    const first = firstLines.get(key);
    if (first === undefined) {
      firstLines.set(key, row.line);
      assets.push(asset);
    } else {
      repeats.push(`  line ${row.line} repeats line ${first}`);
    }
  }
  if (repeats.length > 0) warn(`Repeated rows in ${file}, read once each:\n${repeats.join("\n")}`);

  return assets as Picked<B, T>[];
}

/**
 * The wallet assets on `blockchain`, of `assetType` when given, in the CSV file at `path`, from the
 * working directory. The file needs the columns blockchain, wallet_address and token_address, in any
 * order; other columns are ignored. An empty token_address means the chain's native asset, and
 * Bitcoin rows take no token. The file must be plain UTF-8 CSV, without a BOM. Call it inside a run,
 * not at import, so runSource logs a bad file.
 */
export function readWalletAssets<B extends Blockchain, T extends AssetType<B> = AssetType<B>>(
  path: string,
  blockchain: B,
  assetType?: T,
): Picked<B, T>[] {
  return parseWalletAssets(readFileSync(path, "utf8"), path, blockchain, assetType);
}
