import { readFileSync } from "node:fs";
import { isAddress as isSolanaAddress, type Address as SolanaAddress } from "@solana/kit";
import { isAddress as isEvmAddress, type Address as EvmAddress } from "viem";
import { bitcoinAddress, type BitcoinAddress } from "#src/bitcoin/address.ts";
import { toLower } from "#src/evm/address.ts";
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

/** The wallet assets in CSV text on `blockchain`, of `assetType` when given. `file` names the input in errors. */
export function parseWalletAssets<B extends Blockchain, T extends AssetType<B> = AssetType<B>>(
  text: string,
  file: string,
  blockchain: B,
  assetType?: T,
): Picked<B, T>[] {
  const { rows } = parseCsv(text, file, ["blockchain", "wallet_address", "token_address"]);
  return rows
    .filter((row) => picks(row, blockchain, assetType))
    .map((row) => walletAssetOf(blockchain, row)) as Picked<B, T>[];
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
