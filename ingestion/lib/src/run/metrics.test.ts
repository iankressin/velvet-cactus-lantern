import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunReport } from "#src/run/index.ts";
import { runMetrics } from "#src/run/metrics.ts";

const report: RunReport = {
  runId: "1b4e28ba-2fa1-41d2-883f-0016d3cca427",
  dagsterRunId: undefined,
  source: "ethereum",
  table: "eth_balances",
  startedAt: new Date("2026-11-04T11:59:47.500Z"),
  finishedAt: new Date("2026-11-04T12:00:00Z"),
  error: undefined,
  retriedCalls: 2,
  recordsWritten: 40,
  failedCalls: 3,
  loadSeconds: 0.4,
  backlog: { pending: 3, parked: 1 },
};

async function values(report: RunReport): Promise<Map<string, number>> {
  const metrics = await runMetrics(report).getMetricsAsJSON();
  return new Map(
    metrics.flatMap((m) =>
      m.values.map((v) => {
        const labels = Object.entries(v.labels).map(([k, l]) => `${k}="${l}"`);
        return [labels.length ? `${m.name}{${labels.join(",")}}` : m.name, v.value];
      }),
    ),
  );
}

test("a successful run reports its counts, its backlog and the time of the success", async () => {
  assert.deepEqual(
    await values(report),
    new Map([
      ["ingestion_last_run_timestamp_seconds", 1793793600],
      ["ingestion_last_run_success", 1],
      ["ingestion_last_run_duration_seconds", 12.5],
      ["ingestion_last_run_retried_calls", 2],
      ["ingestion_last_run_records_written", 40],
      ["ingestion_last_run_failed_calls", 3],
      ["ingestion_last_success_timestamp_seconds", 1793793600],
      ['ingestion_dead_letters{state="pending"}', 3],
      ['ingestion_dead_letters{state="parked"}', 1],
    ]),
  );
});

test("a failed run leaves out the success time and the backlog, so the Pushgateway keeps the last ones", async () => {
  const failed = await values({ ...report, error: "connection refused", backlog: undefined });
  assert.equal(failed.get("ingestion_last_run_success"), 0);
  assert.equal(failed.has("ingestion_last_success_timestamp_seconds"), false);
  assert.equal([...failed.keys()].some((k) => k.startsWith("ingestion_dead_letters")), false);
});
