import { Gauge, Pushgateway, Registry } from "@prometheus-io/client";
import * as z from "zod";
import { loadEnv } from "#src/env.ts";
import type { Logger } from "#src/logger.ts";
import type { RunReport } from "#src/run/index.ts";

/**
 * A source runs as a short job, so Prometheus cannot scrape it. Each run pushes these
 * gauges to the Pushgateway instead, grouped by source and table. A failed run leaves out
 * `ingestion_last_success_timestamp_seconds`, and `pushAdd` replaces only the metrics it
 * sends, so the Pushgateway keeps the time of the last success. A run without a backlog
 * leaves out `ingestion_dead_letters` the same way, so the last count stays.
 */
export function runMetrics(report: RunReport): Registry {
  const registry = new Registry();
  const gauge = (name: string, help: string, value: number) =>
    new Gauge({ name, help, registers: [registry] }).set(value);
  const finishedAt = report.finishedAt.getTime() / 1000;
  const succeeded = report.error === undefined;

  gauge("ingestion_last_run_timestamp_seconds", "When the last run finished, successful or not.", finishedAt);
  gauge("ingestion_last_run_success", "1 if the last run succeeded, 0 if it failed.", succeeded ? 1 : 0);
  gauge(
    "ingestion_last_run_duration_seconds",
    "How long the last run took.",
    (report.finishedAt.getTime() - report.startedAt.getTime()) / 1000,
  );
  gauge("ingestion_last_run_retried_calls", "Dead letters from earlier runs that the last run retried.", report.retriedCalls);
  gauge("ingestion_last_run_records_written", "Records the last run wrote to the raw table.", report.recordsWritten);
  gauge("ingestion_last_run_failed_calls", "Calls that failed in the last run and wait as dead letters.", report.failedCalls);
  if (succeeded) {
    gauge("ingestion_last_success_timestamp_seconds", "When the last successful run finished.", finishedAt);
  }
  if (report.backlog) {
    const deadLetters = new Gauge({
      name: "ingestion_dead_letters",
      help: "Dead letters waiting after the last run. Pending ones are retried next run, parked ones wait for a person.",
      labelNames: ["state"],
      registers: [registry],
    });
    deadLetters.set({ state: "pending" }, report.backlog.pending);
    deadLetters.set({ state: "parked" }, report.backlog.parked);
  }
  return registry;
}

const metricsEnv = z.object({ PUSHGATEWAY_URL: z.url().optional() });

/** Never throws: a run that wrote its records stays successful when its metrics cannot be sent. */
export async function pushRunMetrics(report: RunReport, log: Logger): Promise<void> {
  try {
    const { PUSHGATEWAY_URL } = loadEnv(metricsEnv);
    if (!PUSHGATEWAY_URL) {
      log.info("PUSHGATEWAY_URL is not set, so this run pushes no metrics");
      return;
    }
    const gateway = new Pushgateway(PUSHGATEWAY_URL, { timeout: 5000 }, runMetrics(report));
    await gateway.pushAdd({
      jobName: "ingestion",
      groupings: { source: report.source, table: report.table },
    });
  } catch (error) {
    log.warn({ err: error }, "Could not push metrics");
  }
}
