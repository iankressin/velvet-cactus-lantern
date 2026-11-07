import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseWalletAssets, readWalletAssets } from "#src/wallet-assets/wallet-assets.ts";

const HEADER = "blockchain,wallet_address,token_address";
const csv = (...rows: string[]) => [HEADER, ...rows].join("\n") + "\n";

const vitalik = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const usdc = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const solWallet = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const solUsdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const btcWallet = "bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h";

const ethNative = { blockchain: "ethereum", assetType: "native", walletAddress: vitalik.toLowerCase(), tokenAddress: null };
const ethErc20 = { blockchain: "ethereum", assetType: "erc20", walletAddress: vitalik.toLowerCase(), tokenAddress: usdc.toLowerCase() };
const solNative = { blockchain: "solana", assetType: "native", walletAddress: solWallet, tokenAddress: null };
const solSpl = { blockchain: "solana", assetType: "spl", walletAddress: solWallet, tokenAddress: solUsdc };
const btcNative = { blockchain: "bitcoin", assetType: "native", walletAddress: btcWallet, tokenAddress: null };

const mixed = csv(
  `ethereum,${vitalik},`,
  `solana,${solWallet},${solUsdc}`,
  `ethereum,${vitalik},${usdc}`,
  `bitcoin,${btcWallet.toUpperCase()},`,
  `solana,${solWallet},`,
);

test("reads every asset type of the chain when no asset type is given", () => {
  assert.deepEqual(parseWalletAssets(mixed, "wallets.csv", "ethereum"), [ethNative, ethErc20]);
  assert.deepEqual(parseWalletAssets(mixed, "wallets.csv", "solana"), [solSpl, solNative]);
});

test("reads only the asset type asked for", () => {
  assert.deepEqual(parseWalletAssets(mixed, "wallets.csv", "ethereum", "native"), [ethNative]);
  assert.deepEqual(parseWalletAssets(mixed, "wallets.csv", "ethereum", "erc20"), [ethErc20]);
  assert.deepEqual(parseWalletAssets(mixed, "wallets.csv", "solana", "native"), [solNative]);
  assert.deepEqual(parseWalletAssets(mixed, "wallets.csv", "solana", "spl"), [solSpl]);
});

test("re-encodes an uppercase bech32 Bitcoin address in lowercase", () => {
  assert.deepEqual(parseWalletAssets(mixed, "wallets.csv", "bitcoin"), [btcNative]);
});

test("reads each source's share of the example file", () => {
  const example = fileURLToPath(new URL("./example.csv", import.meta.url));
  assert.equal(readWalletAssets(example, "ethereum", "native").length, 2);
  assert.equal(readWalletAssets(example, "ethereum", "erc20").length, 3);
  assert.equal(readWalletAssets(example, "solana", "native").length, 1);
  assert.equal(readWalletAssets(example, "solana", "spl").length, 2);
  assert.equal(readWalletAssets(example, "bitcoin").length, 2);
});

// Checked by `pnpm typecheck`, never run: each chain offers only its own asset types,
// and the asset type narrows what comes back.
export const typeChecks = (path: string) => {
  // @ts-expect-error Bitcoin has only its native asset.
  readWalletAssets(path, "bitcoin", "erc20");
  // @ts-expect-error Ethereum tokens are erc20.
  readWalletAssets(path, "ethereum", "spl");
  // @ts-expect-error Solana tokens are spl.
  readWalletAssets(path, "solana", "erc20");
  const tokens: { tokenAddress: `0x${string}` }[] = readWalletAssets(path, "ethereum", "erc20");
  return tokens;
};
