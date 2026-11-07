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

/** One line of the wallet asset CSV: its cells as written, and the wallet asset it names or why it names none. */
export type WalletAssetLine = {
  /** The line the row ends on. The header is line 1. */
  line: number;
  /** The cells as written. A missing cell is "". */
  blockchain: string;
  walletAddress: string;
  tokenAddress: string;
  /** Null exactly when `problems` is not empty. */
  asset: WalletAsset | null;
  problems: string[];
};

/** Native when token_address is empty or missing, else the chain's token type: null on a chain without tokens. */
const assetTypeOf = (blockchain: Blockchain, tokenAddress: string | undefined) =>
  tokenAddress ? chains[blockchain].tokenType : "native";

/**
 * Whether a read of `blockchain`, and of `assetType` when given, takes the line. A token line on a
 * chain without tokens counts as part of every read of that chain, so its warning reaches that chain's source.
 */
function picks(line: WalletAssetLine, blockchain: Blockchain, assetType: AssetType | undefined): boolean {
  if (line.blockchain !== blockchain) return false;
  const type = assetTypeOf(blockchain, line.tokenAddress);
  return assetType === undefined || type === null || type === assetType;
}

/** What is wrong with a row on a known chain, in the words of the person who fixes the file. */
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
    assetType: assetTypeOf(blockchain, token),
    walletAddress: chain.address(row.record.walletAddress ?? ""),
    tokenAddress: token ? chain.address(token) : null,
  } as WalletAsset;
}

/** A row's cells as written, with its wallet asset or its problems. */
function lineOf(row: CsvRow, columnCount: number): WalletAssetLine {
  const { blockchain = "", walletAddress = "", tokenAddress = "" } = row.record;
  const cells = { line: row.line, blockchain, walletAddress, tokenAddress };
  if (!isBlockchain(blockchain)) {
    return { ...cells, asset: null, problems: [`blockchain "${blockchain}" is not ethereum, solana or bitcoin`] };
  }
  const problems = problemsWith(blockchain, row, columnCount);
  return { ...cells, asset: problems.length === 0 ? walletAssetOf(blockchain, row) : null, problems };
}

/**
 * Every line of CSV text, repeats included, in file order. `file` names the input in errors. Throws
 * only for a problem with the whole file: a missing column, a BOM, no rows.
 */
export function parseWalletAssetLines(text: string, file: string): WalletAssetLine[] {
  const { columns, rows } = parseCsv(text, file, ["blockchain", "wallet_address", "token_address"]);
  return rows.map((row) => lineOf(row, columns.length));
}

/** Every line of the CSV file at `path`, from the working directory. See parseWalletAssetLines. */
export function readWalletAssetLines(path: string): WalletAssetLine[] {
  return parseWalletAssetLines(readFileSync(path, "utf8"), path);
}

/**
 * The wallet assets in CSV text on `blockchain`, of `assetType` when given. `file` names the input in
 * messages. Bad rows this read picks, rows on an unknown chain, which no read picks, and repeated rows
 * go to `warn`; the read skips them. Only a problem with the whole file throws.
 */
export function parseWalletAssets<B extends Blockchain, T extends AssetType<B> = AssetType<B>>(
  text: string,
  file: string,
  blockchain: B,
  assetType?: T,
  warn: (message: string) => void = (message) => logger.warn(message),
): Picked<B, T>[] {
  const lines = parseWalletAssetLines(text, file);

  const unread = lines
    .filter((line) => !isBlockchain(line.blockchain))
    .map((line) => `  line ${line.line}: blockchain "${line.blockchain}" is not ethereum, solana or bitcoin`);
  if (unread.length > 0) warn(`Rows in ${file} that no source reads:\n${unread.join("\n")}`);

  const picked = lines.filter((line) => picks(line, blockchain, assetType));
  const problems = picked.flatMap((line) => line.problems.map((problem) => `  line ${line.line}: ${problem}`));
  if (problems.length > 0) {
    const read = assetType === undefined ? blockchain : `${blockchain} ${assetType}`;
    warn(`Invalid ${read} rows in ${file}, skipped:\n${problems.join("\n")}`);
  }

  const firstLines = new Map<string, number>();
  const assets: WalletAsset[] = [];
  const repeats: string[] = [];
  for (const { line, asset } of picked) {
    if (asset === null) continue;
    const key = `${asset.walletAddress}:${asset.tokenAddress ?? ""}`;
    const first = firstLines.get(key);
    if (first === undefined) {
      firstLines.set(key, line);
      assets.push(asset);
    } else {
      repeats.push(`  line ${line} repeats line ${first}`);
    }
  }
  if (repeats.length > 0) warn(`Repeated rows in ${file}, read once each:\n${repeats.join("\n")}`);

  return assets as Picked<B, T>[];
}

/**
 * The wallet assets on `blockchain`, of `assetType` when given, in the CSV file at `path`, from the
 * working directory. The file needs the columns blockchain, wallet_address and token_address, in any
 * order; other columns are ignored. An empty token_address means the chain's native asset, and
 * Bitcoin rows take no token. The file must be plain UTF-8 CSV, without a BOM. A bad row is skipped
 * with a warning. Call it inside a run, not at import, so runSource logs a bad file.
 */
export function readWalletAssets<B extends Blockchain, T extends AssetType<B> = AssetType<B>>(
  path: string,
  blockchain: B,
  assetType?: T,
): Picked<B, T>[] {
  return parseWalletAssets(readFileSync(path, "utf8"), path, blockchain, assetType);
}
