import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { inputWalletAssets } from "#src/source.ts";

const vitalik = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

/** Writes a CSV with `header` and `rows` to a temp file, and returns its path. */
async function csvFile(t: TestContext, header: string, ...rows: string[]) {
  const dir = await mkdtemp(join(tmpdir(), "input-wallet-assets-"));
  t.after(() => rm(dir, { recursive: true }));
  const path = join(dir, "wallet-assets.csv");
  await writeFile(path, [header, ...rows].join("\n") + "\n");
  return path;
}

const HEADER = "blockchain,wallet_address,token_address";

async function firstBatch(WALLET_ASSETS_CSV: string) {
  for await (const batch of inputWalletAssets.extract({ WALLET_ASSETS_CSV }, [])) return batch;
  assert.fail("the run yielded no batch");
}

test("loads every line, valid or not, under one load id", async (t) => {
  const path = await csvFile(
    t,
    HEADER,
    `ethereum,${vitalik},`,
    "ethereum,0x123,",
    "ethereum,0x456,ETH",
    `Ethereum,${vitalik},`,
    `ethereum,${vitalik},`,
  );

  const batch = await firstBatch(path);

  assert.deepEqual(batch.failed, []);
  const loadId = batch.records[0]?.data.load_id;
  assert.equal(typeof loadId, "string");
  assert.deepEqual(
    batch.records.map(({ id, callId }) => [id, callId]),
    [2, 3, 4, 5, 6].map((line) => [`${loadId}:${line}`, `${loadId}:${line}`]),
  );
  const native = {
    load_id: loadId,
    blockchain: "ethereum",
    wallet_address: vitalik,
    token_address: "",
    asset_type: "native",
    wallet: vitalik.toLowerCase(),
    token: null,
    problem: null,
  };
  assert.deepEqual(batch.records[0]?.data, { ...native, line: 2 });
  assert.deepEqual(batch.records[2]?.data, {
    load_id: loadId,
    line: 4,
    blockchain: "ethereum",
    wallet_address: "0x456",
    token_address: "ETH",
    asset_type: null,
    wallet: null,
    token: null,
    problem: 'wallet_address "0x456" is not an Ethereum address; token_address "ETH" is not an Ethereum address; leave it empty for ETH',
  });
  assert.equal(batch.records[3]?.data.problem, 'blockchain "Ethereum" is not ethereum, solana or bitcoin');
  assert.deepEqual(batch.records[4]?.data, { ...native, line: 6 }, "a repeated line is still loaded");
});

test("gives each run a new load id", async (t) => {
  const path = await csvFile(t, HEADER, `ethereum,${vitalik},`);
  const first = await firstBatch(path);
  const second = await firstBatch(path);
  assert.notEqual(first.records[0]?.data.load_id, second.records[0]?.data.load_id);
});

test("a CSV without a token_address column fails the run", async (t) => {
  const path = await csvFile(t, "blockchain,wallet_address,mint", `ethereum,${vitalik},`);
  await assert.rejects(firstBatch(path), {
    message: `${path} is missing columns: token_address; its header is "blockchain,wallet_address,mint"`,
  });
});
