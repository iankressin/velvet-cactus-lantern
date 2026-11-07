import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { bitcoinBtcBalances } from "#src/source.ts";

// No node listens here, so a run's batch fails each wallet it asked for, which shows the wallets it read.
const DSHACKLE_URL = "http://127.0.0.1:1";

const bech32 = "bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h";
const p2pkh = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";

/** Writes a wallet asset CSV with `rows` under its header to a temp file, and returns its path. */
async function walletAssetsCsv(t: TestContext, ...rows: string[]) {
  const dir = await mkdtemp(join(tmpdir(), "bitcoin-btc-balances-"));
  t.after(() => rm(dir, { recursive: true }));
  const path = join(dir, "wallet-assets.csv");
  await writeFile(path, ["blockchain,wallet_address,token_address", ...rows].join("\n") + "\n");
  return path;
}

async function firstBatch(WALLET_ASSETS_CSV: string) {
  for await (const batch of bitcoinBtcBalances.extract({ DSHACKLE_URL, WALLET_ASSETS_CSV }, [])) return batch;
  assert.fail("the run yielded no batch");
}

test("reads the shared wallet asset CSV unless WALLET_ASSETS_CSV says otherwise", () => {
  assert.deepEqual(bitcoinBtcBalances.env.parse({ DSHACKLE_URL }), {
    DSHACKLE_URL,
    WALLET_ASSETS_CSV: "../../wallet-assets.csv",
  });
  assert.deepEqual(bitcoinBtcBalances.env.parse({ DSHACKLE_URL, WALLET_ASSETS_CSV: "mine.csv" }), {
    DSHACKLE_URL,
    WALLET_ASSETS_CSV: "mine.csv",
  });
});

test("reads only the Bitcoin rows, so a bad Ethereum or Solana row does not fail the run", async (t) => {
  const path = await walletAssetsCsv(
    t,
    "ethereum,0x123,",
    `bitcoin,${bech32.toUpperCase()},`,
    "solana,nope,",
    `bitcoin,${p2pkh},`,
  );
  const batch = await firstBatch(path);
  // The bech32 wallet comes back lowercase, as earlier runs wrote it.
  assert.deepEqual(
    batch.failed.map(({ call }) => call),
    [
      { kind: "btc_balance", wallet: bech32 },
      { kind: "btc_balance", wallet: p2pkh },
    ],
  );
});

test("a bad Bitcoin row fails the run, not the import", async (t) => {
  const path = await walletAssetsCsv(t, `bitcoin,${bech32},`, "bitcoin,nope,");
  await assert.rejects(firstBatch(path), {
    message: `Invalid bitcoin rows in ${path}:\n  line 3: wallet_address "nope" is not a Bitcoin address`,
  });
});

test("a Bitcoin row with a token fails the run", async (t) => {
  const path = await walletAssetsCsv(t, `bitcoin,${bech32},0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`);
  await assert.rejects(firstBatch(path), {
    message: `Invalid bitcoin rows in ${path}:\n  line 2: bitcoin has no tokens; leave token_address empty`,
  });
});
