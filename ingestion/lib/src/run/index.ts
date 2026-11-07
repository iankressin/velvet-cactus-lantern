import { randomUUID } from "node:crypto";
import * as z from "zod";
import { describeError } from "#src/calls.ts";
import { loadEnv } from "#src/env.ts";
import { logger } from "#src/logger.ts";
import { pushRunMetrics } from "#src/run/metrics.ts";
import type { Source, StreamSource } from "#src/source.ts";
import { postgresWarehouse, type DeadLetterBacklog, type Warehouse } from "#src/warehouse/index.ts";

const runEnv = z.object({ DAGSTER_RUN_ID: z.string().min(1).optional() });
const MAX_BLOCKS_PER_RUN = 1_000_000;

/** What runSource reports when a run ends, to the Pushgateway and to ops.ingestion_runs. */
export type RunReport = {
  runId: string;
  /** Set when Dagster started the run. */
  dagsterRunId: string | undefined;
  source: string;
  table: string;
  startedAt: Date;
  finishedAt: Date;
  /** Undefined when the run succeeded. */
  error: string | undefined;
  retriedCalls: number;
  recordsWritten: number;
  failedCalls: number;
  /** Time spent writing records and dead letters to the warehouse. The rest went to extraction. */
  loadSeconds: number;
  /** Undefined when the run failed before it counted its dead letters. */
  backlog: DeadLetterBacklog | undefined;
};

/**
 * The entry point of every source. A call source has its dead letters that still parse
 * retried, and each batch it yields loaded. A stream source is piped into the warehouse,
 * where Pipes resumes it after the last block it loaded. Either way, runSource counts what
 * happened. Failed calls only warn; the records that did arrive are kept.
 *
 * Any error, including an invalid environment, is logged once as fatal and sets the exit
 * code, instead of reaching Node's own crash output. Every run pushes its metrics and adds
 * a row to the warehouse's run log.
 */
export async function runSource<E, C>(
  source: Source<E, C> | StreamSource<E>,
  warehouse: Warehouse = postgresWarehouse(),
): Promise<void> {
  const runId = randomUUID();
  const { DAGSTER_RUN_ID } = loadEnv(runEnv);
  const log = logger.child({ source: source.name, table: source.table });
  const startedAt = new Date();
  let retriedCalls = 0;
  let recordsWritten = 0;
  let failedCalls = 0;
  let loadSeconds = 0;
  let backlog: DeadLetterBacklog | undefined;
  let error: string | undefined;

  try {
    const env = loadEnv(source.env);
    const table = await warehouse.open(`${source.name}_${source.table}`);
    try {
      if ("stream" in source) {
        log.info({ runId }, "Run started");
        const stream = await source.stream(env);
        await stream.pipeTo(
          table.pipesTarget({
            maxBlocks: source.maxBlocksPerRun ?? MAX_BLOCKS_PER_RUN,
            onLoad({ records, seconds }) {
              loadSeconds += seconds;
              recordsWritten += records;
              log.info({ target: table.name, records }, "Batch written");
            },
          }),
        );
      } else {
        const { calls: retry, parked } = await table.retries(source.call);
        if (parked > 0) {
          log.warn(
            { parked, deadLetters: table.deadLetters },
            "Some dead letters no longer match the source's call schema and wait for a person",
          );
        }
        retriedCalls = retry.length;
        log.info({ runId, retriedCalls }, "Run started");

        for await (const batch of source.extract(env, retry)) {
          const loadStartedAt = performance.now();
          await table.load(batch);
          loadSeconds += (performance.now() - loadStartedAt) / 1000;
          recordsWritten += batch.records.length;
          failedCalls += batch.failed.length;
          log.info(
            {
              target: table.name,
              records: batch.records.length,
              failedCalls: batch.failed.length,
            },
            "Batch written",
          );
        }
      }

      backlog = await table.backlog();
      log.info({ recordsWritten, failedCalls, backlog }, "Run finished");
      if (failedCalls > 0) {
        log.warn(
          { failedCalls, deadLetters: table.deadLetters },
          "Some calls failed and wait as dead letters for the next run",
        );
      }
    } finally {
      await table.close();
    }
  } catch (err) {
    log.fatal({ err }, "Run failed");
    error = describeError(err);
    process.exitCode = 1;
  }

  const report: RunReport = {
    runId,
    dagsterRunId: DAGSTER_RUN_ID,
    source: source.name,
    table: source.table,
    startedAt,
    finishedAt: new Date(),
    error,
    retriedCalls,
    recordsWritten,
    failedCalls,
    loadSeconds,
    backlog,
  };
  await Promise.all([pushRunMetrics(report, log), warehouse.recordRun(report, log)]);
}
