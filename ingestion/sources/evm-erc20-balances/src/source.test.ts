import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { forChain } from "#src/source.ts";

const env = { BLOCK_NUMBER: "latest", EVM_RPC_URL: "http://127.0.0.1:1", RPC_BATCH_SIZE: 1, RPC_MAX_CONCURRENCY: 1 } as const;

/** Runs the rest of the test from a folder whose chains/ethereum/addresses.json holds `json`, as a source runs from its package. */
async function addressesHold(t: TestContext, json: string) {
  const dir = await mkdtemp(join(tmpdir(), "evm-erc20-balances-"));
  const cwd = process.cwd();
  t.after(async () => {
    process.chdir(cwd);
    await rm(dir, { recursive: true });
  });
  await mkdir(join(dir, "chains", "ethereum"), { recursive: true });
  await writeFile(join(dir, "chains", "ethereum", "addresses.json"), json);
  process.chdir(dir);
}

const firstBatch = () => forChain("ethereum").extract(env, [])[Symbol.asyncIterator]().next();

test("a bad address in addresses.json fails the run, not the import", async (t) => {
  await addressesHold(t, JSON.stringify({ wallets: ["0xnot-an-address"], tokens: [] }));
  await assert.rejects(firstBatch(), {
    message: "Invalid Ethereum addresses:\n  0xnot-an-address",
  });
});

test("malformed addresses.json fails the run, not the import", async (t) => {
  await addressesHold(t, '{ "wallets": [], }');
  await assert.rejects(firstBatch(), /chains\/ethereum\/addresses\.json is not valid JSON/);
});

test("each chain loads into a table of its own", () => {
  assert.equal(forChain("ethereum").name, "ethereum", "runSource writes to raw.ethereum_erc20_balances");
  assert.equal(forChain("ethereum").table, "erc20_balances");
  assert.throws(() => forChain("Ethereum Mainnet"), /chain name/);
});
