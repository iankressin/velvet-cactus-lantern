import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { solanaSplBalances } from "#src/source.ts";

const env = { SOLANA_RPC_URL: "http://127.0.0.1:1" };

/** Runs the rest of the test from a folder whose addresses.json holds `json`, as a source runs from its package. */
async function addressesHold(t: TestContext, json: string) {
  const dir = await mkdtemp(join(tmpdir(), "solana-spl-balances-"));
  const cwd = process.cwd();
  t.after(async () => {
    process.chdir(cwd);
    await rm(dir, { recursive: true });
  });
  await writeFile(join(dir, "addresses.json"), json);
  process.chdir(dir);
}

const firstBatch = () => solanaSplBalances.extract(env, [])[Symbol.asyncIterator]().next();

test("a bad address in addresses.json fails the run, not the import", async (t) => {
  await addressesHold(t, JSON.stringify({ wallets: ["not-an-address"], mints: [] }));
  await assert.rejects(firstBatch(), {
    message: "Invalid Solana addresses:\n  not-an-address",
  });
});

test("malformed addresses.json fails the run, not the import", async (t) => {
  await addressesHold(t, '{ "wallets": [], }');
  await assert.rejects(firstBatch(), /addresses\.json is not valid JSON/);
});
