import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  parseWalletAssets,
  readWalletAssets,
  type AssetType,
  type Blockchain,
} from "#src/wallet-assets/wallet-assets.ts";

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

const noWarnings = (message: string) => assert.fail(`unexpected warning: ${message}`);
const badChecksum = "0xa0B86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const testnet = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";

const withBadRows = csv(
  `ethereum,${vitalik},`,
  `ethereum,0x123,`,
  `ethereum,0x456,ETH`,
  `ethereum,${badChecksum},${usdc}`,
  `solana,${solWallet},`,
  `solana,${solWallet},SOL`,
  `bitcoin,${btcWallet},${usdc}`,
  `bitcoin,${btcWallet}`,
  `bitcoin,${testnet},`,
);

test("fails only the read whose rows are bad, listing each problem by line", () => {
  const read = (blockchain: Blockchain, assetType?: AssetType) =>
    parseWalletAssets(withBadRows, "wallets.csv", blockchain, assetType, noWarnings);

  assert.throws(() => read("ethereum", "native"), {
    message: 'Invalid ethereum native rows in wallets.csv:\n  line 3: wallet_address "0x123" is not an Ethereum address',
  });
  assert.throws(() => read("ethereum", "erc20"), {
    message: [
      "Invalid ethereum erc20 rows in wallets.csv:",
      '  line 4: wallet_address "0x456" is not an Ethereum address',
      '  line 4: token_address "ETH" is not an Ethereum address; leave it empty for ETH',
      `  line 5: wallet_address "${badChecksum}" is not an Ethereum address`,
    ].join("\n"),
  });
  assert.throws(() => read("ethereum"), { message: /^Invalid ethereum rows in wallets\.csv:\n  line 3: .*\n  line 4: .*\n  line 4: .*\n  line 5: / });
  assert.deepEqual(read("solana", "native"), [solNative]);
  assert.throws(() => read("solana", "spl"), {
    message: 'Invalid solana spl rows in wallets.csv:\n  line 7: token_address "SOL" is not a Solana address; leave it empty for SOL',
  });
  assert.throws(() => read("bitcoin"), {
    message: [
      "Invalid bitcoin rows in wallets.csv:",
      "  line 8: bitcoin has no tokens; leave token_address empty",
      "  line 9: has 2 cells; the header has 3",
      `  line 10: wallet_address "${testnet}" is not a Bitcoin address`,
    ].join("\n"),
  });
});

test("warns in every read about rows on a chain no source reads", () => {
  const warnings: string[] = [];
  const text = csv(`Ethereum,${vitalik},`, `ethereum,${vitalik},`);
  assert.deepEqual(parseWalletAssets(text, "wallets.csv", "ethereum", "native", (m) => warnings.push(m)), [ethNative]);
  assert.deepEqual(parseWalletAssets(text, "wallets.csv", "bitcoin", undefined, (m) => warnings.push(m)), []);
  const warning = 'Rows in wallets.csv that no source reads:\n  line 2: blockchain "Ethereum" is not ethereum, solana or bitcoin';
  assert.deepEqual(warnings, [warning, warning]);
});

test("reads a repeated wallet asset once and warns with the lines that repeat it", () => {
  const warnings: string[] = [];
  const text = csv(
    `ethereum,${vitalik},${usdc}`,
    `ethereum,${vitalik},`,
    `ethereum,${vitalik.toLowerCase()},${usdc.toLowerCase()}`,
    `ethereum,${vitalik},`,
  );
  assert.deepEqual(parseWalletAssets(text, "wallets.csv", "ethereum", undefined, (m) => warnings.push(m)), [ethErc20, ethNative]);
  assert.deepEqual(warnings, [
    "Repeated rows in wallets.csv, read once each:\n  line 4 repeats line 2\n  line 5 repeats line 3",
  ]);
});
