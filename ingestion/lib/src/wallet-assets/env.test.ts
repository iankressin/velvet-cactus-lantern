import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { evmBlockchain, walletAssetsEnv } from "#src/wallet-assets/env.ts";
import { readWalletAssets } from "#src/wallet-assets/wallet-assets.ts";

test("points a balance source at ingestion/wallet-assets.csv unless WALLET_ASSETS_CSV says otherwise", () => {
  assert.deepEqual(walletAssetsEnv.parse({}), { WALLET_ASSETS_CSV: "../../wallet-assets.csv" });
  assert.deepEqual(walletAssetsEnv.parse({ WALLET_ASSETS_CSV: "mine.csv" }), { WALLET_ASSETS_CSV: "mine.csv" });
});

test("the default path, from a source's package folder, reaches a file every balance source can read", () => {
  // Sources run from their package folder, so the default resolves against it.
  const { WALLET_ASSETS_CSV } = walletAssetsEnv.parse({});
  const path = fileURLToPath(new URL(WALLET_ASSETS_CSV, new URL("../../../sources/bitcoin-btc-balances/", import.meta.url)));
  assert.ok(readWalletAssets(path, "ethereum", "native").length > 0);
  assert.ok(readWalletAssets(path, "ethereum", "erc20").length > 0);
  assert.ok(readWalletAssets(path, "solana", "native").length > 0);
  assert.ok(readWalletAssets(path, "solana", "spl").length > 0);
  assert.ok(readWalletAssets(path, "bitcoin").length > 0);
});

test("names only the EVM chains a wallet asset CSV can hold", () => {
  assert.equal(evmBlockchain.parse("ethereum"), "ethereum");
  assert.throws(() => evmBlockchain.parse("base"));
});
