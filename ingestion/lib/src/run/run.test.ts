import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import * as z from "zod";
import { runSource } from "#src/run/index.ts";
import type { Batch, Source } from "#src/source.ts";
import { pgliteWarehouse } from "#src/warehouse/pglite.fixture.ts";

// loadEnv treats an empty value as unset, so the run pushes no metrics, even when the shell
// or a .env file sets PUSHGATEWAY_URL.
process.env.PUSHGATEWAY_URL = "";

type Wallet = { wallet: string };

const source = (
  extract: (retry: Wallet[]) => AsyncIterable<Batch<Wallet>>,
  env: z.ZodType = z.object({}),
): Source<unknown, Wallet> => ({
  name: "test",
  table: "wallets",
  env,
  call: z.object({ wallet: z.string() }),
  extract: (_env, retry) => extract(retry),
});

async function runLog(db: PGlite) {
  const { rows } = await db.query<Record<string, unknown>>(
    `select succeeded, records_written, failed_calls, retried_calls,
            dead_letters_pending, dead_letters_parked, error
     from ops.ingestion_runs order by started_at, finished_at`,
  );
  return rows;
}

test("a run retries the dead letters of earlier runs and records what it did", async (t) => {
  const { db, warehouse } = await pgliteWarehouse(t);
  let retried: Wallet[] = [];

  await runSource(
    source(async function* () {
      yield { records: [{ id: "a", callId: "a", data: {} }], failed: [{ id: "c", call: { wallet: "c" }, error: "timeout" }] };
    }),
    warehouse,
  );
  await runSource(
    source(async function* (retry) {
      retried = retry;
      yield { records: retry.map((c) => ({ id: `2:${c.wallet}`, callId: c.wallet, data: {} })), failed: [] };
    }),
    warehouse,
  );

  assert.equal(process.exitCode, undefined, "both runs succeeded");
  assert.deepEqual(retried, [{ wallet: "c" }]);
  assert.deepEqual(await runLog(db), [
    { succeeded: true, records_written: 1, failed_calls: 1, retried_calls: 0, dead_letters_pending: 1, dead_letters_parked: 0, error: null },
    { succeeded: true, records_written: 1, failed_calls: 0, retried_calls: 1, dead_letters_pending: 0, dead_letters_parked: 0, error: null },
  ]);
});

test("a run that fails keeps the batches it loaded and records the error", async (t) => {
  const { db, warehouse } = await pgliteWarehouse(t);

  await runSource(
    source(async function* () {
      yield { records: [{ id: "g", callId: "g", data: {} }], failed: [] };
      throw new Error("boom");
    }),
    warehouse,
  );

  assert.equal(process.exitCode, 1);
  process.exitCode = undefined;
  assert.deepEqual((await db.query("select id from raw.test_wallets")).rows, [{ id: "g" }]);
  assert.deepEqual(await runLog(db), [
    { succeeded: false, records_written: 1, failed_calls: 0, retried_calls: 0, dead_letters_pending: null, dead_letters_parked: null, error: "boom" },
  ]);
});

test("an invalid environment fails the run, and the run log says why", async (t) => {
  const { db, warehouse } = await pgliteWarehouse(t);

  await runSource(
    source(async function* () {}, z.object({ RUN_TEST_ENDPOINT: z.url() })),
    warehouse,
  );

  assert.equal(process.exitCode, 1);
  process.exitCode = undefined;
  const [row] = await runLog(db);
  assert.equal(row?.succeeded, false);
  assert.match(String(row?.error), /Invalid environment[\s\S]*RUN_TEST_ENDPOINT/);
});
