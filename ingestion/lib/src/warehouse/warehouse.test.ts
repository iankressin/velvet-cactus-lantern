import assert from "node:assert/strict";
import { test } from "node:test";
import * as z from "zod";
import { logger, type Logger } from "#src/logger.ts";
import type { RunReport } from "#src/run/index.ts";
import { postgresWarehouse } from "#src/warehouse/index.ts";
import { pgliteWarehouse } from "#src/warehouse/pglite.fixture.ts";

const wallet = z.object({ wallet: z.string() });
const record = (id: string, data: Record<string, unknown> = {}) => ({ id, callId: id, data });
const failure = (id: string, call: unknown = { wallet: id }) => ({ id, call, error: `timeout ${id}` });

const report: RunReport = {
  runId: "1b4e28ba-2fa1-41d2-883f-0016d3cca427",
  dagsterRunId: "dagster-1",
  source: "test",
  table: "wallets",
  startedAt: new Date("2026-11-04T11:59:47.500Z"),
  finishedAt: new Date("2026-11-04T12:00:00Z"),
  error: "boom",
  retriedCalls: 2,
  recordsWritten: 40,
  failedCalls: 3,
  loadSeconds: 0.5,
  backlog: undefined,
};

test("a rerun replaces a record, and a batch that repeats an id keeps the last", async (t) => {
  const { db, warehouse } = await pgliteWarehouse(t);
  const table = await warehouse.open("test_wallets");

  await table.load({ records: [record("a", { v: 1 }), record("b", { v: 1 }), record("b", { v: 2n ** 70n })], failed: [] });
  await table.load({ records: [record("a", { v: 2 })], failed: [] });

  const { rows } = await db.query("select id, data from raw.test_wallets order by id");
  assert.deepEqual(rows, [
    { id: "a", data: { v: 2 } },
    { id: "b", data: { v: "1180591620717411303424" } },
  ]);
});

test("a batch that fails to load leaves no record and clears no dead letter", async (t) => {
  const { db, warehouse } = await pgliteWarehouse(t);
  const table = await warehouse.open("test_wallets");
  await table.load({ records: [], failed: [failure("a")] });

  // A failed call with no call breaks the not-null constraint, so the batch's last step fails.
  await assert.rejects(table.load({ records: [record("a")], failed: [{ id: "x", call: undefined, error: "e" }] }));

  assert.deepEqual((await db.query("select id from raw.test_wallets")).rows, []);
  assert.deepEqual(await table.backlog(), { pending: 1, parked: 0 });
});

test("a failed call is retried by each run until its fifth failure parks it", async (t) => {
  const { warehouse } = await pgliteWarehouse(t);
  const table = await warehouse.open("test_wallets");

  const retried: unknown[] = [];
  for (let run = 0; run < 5; run++) {
    retried.push((await table.retries(wallet)).calls);
    await table.load({ records: [], failed: [failure("w")] });
  }

  assert.deepEqual(retried, [[], ...Array(4).fill([{ wallet: "w" }])]);
  assert.deepEqual(await table.retries(wallet), { calls: [], parked: 0 });
  assert.deepEqual(await table.backlog(), { pending: 0, parked: 1 });
});

test("a record clears the dead letter of the call it answers, under its own row id", async (t) => {
  const { warehouse } = await pgliteWarehouse(t);
  const table = await warehouse.open("test_wallets");
  await table.load({ records: [], failed: [failure("W")] });

  const { calls } = await table.retries(wallet);
  await table.load({ records: calls.map((c) => ({ id: `205:${c.wallet}`, callId: c.wallet, data: {} })), failed: [] });

  assert.deepEqual(calls, [{ wallet: "W" }]);
  assert.deepEqual(await table.backlog(), { pending: 0, parked: 0 });
});

test("a successful call with no records clears its dead letter", async (t) => {
  const { db, warehouse } = await pgliteWarehouse(t);
  const table = await warehouse.open("test_wallets");
  await table.load({ records: [], failed: [failure("a")] });

  await table.load({ records: [], failed: [], succeededCallIds: ["a"] });

  assert.deepEqual((await db.query("select id from raw.test_wallets")).rows, []);
  assert.deepEqual(await table.backlog(), { pending: 0, parked: 0 });
});

test("a dead letter whose call no longer parses is parked with the reason, and the rest are retried", async (t) => {
  const { db, warehouse } = await pgliteWarehouse(t);
  const table = await warehouse.open("test_wallets");
  await table.load({ records: [], failed: [failure("a"), failure("b", { address: "b" })] });

  assert.deepEqual(await table.retries(wallet), { calls: [{ wallet: "a" }], parked: 1 });
  assert.deepEqual(await table.backlog(), { pending: 1, parked: 1 });
  const { rows } = await db.query<{ error: string }>("select error from raw._dead_letters where id = 'b'");
  assert.match(rows[0]!.error, /no longer matches the source's call schema.*wallet/);
});

test("each source table keeps its own dead letters", async (t) => {
  const { warehouse } = await pgliteWarehouse(t);
  const eth = await warehouse.open("ethereum_balances");
  const sol = await warehouse.open("solana_balances");

  await eth.load({ records: [], failed: [failure("w")] });
  await sol.load({ records: [record("w")], failed: [] });

  assert.deepEqual(await eth.backlog(), { pending: 1, parked: 0 });
  assert.deepEqual(await sol.backlog(), { pending: 0, parked: 0 });
  assert.deepEqual(await sol.retries(wallet), { calls: [], parked: 0 });
});

test("the run log gets one row per run, which ops.pipeline_runs reads", async (t) => {
  const { db, warehouse } = await pgliteWarehouse(t);

  await warehouse.recordRun(report, logger);

  const { rows } = await db.query(
    `select run_id, dagster_run_id, source, table_name, started_at, finished_at, succeeded,
            records_written, failed_calls, retried_calls, load_seconds,
            dead_letters_pending, dead_letters_parked, error
     from ops.ingestion_runs`,
  );
  assert.deepEqual(rows, [
    {
      run_id: report.runId,
      dagster_run_id: "dagster-1",
      source: "test",
      table_name: "wallets",
      started_at: report.startedAt,
      finished_at: report.finishedAt,
      succeeded: false,
      records_written: 40,
      failed_calls: 3,
      retried_calls: 2,
      load_seconds: 0.5,
      dead_letters_pending: null,
      dead_letters_parked: null,
      error: "boom",
    },
  ]);
  const pipeline = await db.query("select run_key, status, sources_failed::integer from ops.pipeline_runs");
  assert.deepEqual(pipeline.rows, [{ run_key: "dagster-1", status: "failed", sources_failed: 1 }]);
});

test("a run log row that cannot be written only warns", async () => {
  const warnings: string[] = [];
  const log = { warn: (_: unknown, message: string) => warnings.push(message) } as unknown as Logger;
  const warehouse = postgresWarehouse({
    schema: "raw",
    connect: async () => {
      throw new Error("connection refused");
    },
  });

  await warehouse.recordRun(report, log);

  assert.deepEqual(warnings, ["Could not record the run in ops.ingestion_runs"]);
});
