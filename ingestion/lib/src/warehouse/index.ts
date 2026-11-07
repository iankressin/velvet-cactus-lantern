import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as z from "zod";
import { chunk, uniqueBy } from "#src/calls.ts";
import { loadEnv } from "#src/env.ts";
import type { Logger } from "#src/logger.ts";
import type { RunReport } from "#src/run/index.ts";
import type { Batch } from "#src/source.ts";
import { pipesTarget, type PipesTargetOptions } from "#src/warehouse/stream.ts";

/**
 * Pending dead letters are retried next run. Parked ones failed too often, or no longer match
 * the source's call schema, and wait for a person.
 */
export type DeadLetterBacklog = {
  pending: number;
  parked: number;
};

/** What the warehouse needs from a connection: a pg client in production, PGlite in tests. */
export type Connection = {
  query<R>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
  /** The same connection as a Drizzle database, which Pipes' Postgres target needs to keep a stream source's cursor. */
  drizzle(): NodePgDatabase;
  close(): Promise<void>;
};

/** What the warehouse's statements run through: its own connection, or a transaction Pipes opened. */
export type Query = Pick<Connection, "query">;

/** Where the warehouse lives: the schema that holds the raw tables and dead letters, and how to reach it. */
export type WarehouseSettings = {
  schema: string;
  connect(): Promise<Connection>;
};

export type Warehouse = ReturnType<typeof postgresWarehouse>;

const postgresEnv = z.object({
  WAREHOUSE_HOST: z.string().min(1),
  WAREHOUSE_PORT: z.coerce.number().int().positive(),
  WAREHOUSE_USER: z.string().min(1),
  WAREHOUSE_PASSWORD: z.string(),
  WAREHOUSE_DB: z.string().min(1),
  RAW_SCHEMA: z.string().min(1),
});

function postgresFromEnv(): WarehouseSettings {
  const env = loadEnv(postgresEnv);
  return {
    schema: env.RAW_SCHEMA,
    async connect() {
      const client = new pg.Client({
        host: env.WAREHOUSE_HOST,
        port: env.WAREHOUSE_PORT,
        user: env.WAREHOUSE_USER,
        password: env.WAREHOUSE_PASSWORD,
        database: env.WAREHOUSE_DB,
      });
      await client.connect();
      return {
        query: <R>(text: string, params?: unknown[]) => client.query<R & pg.QueryResultRow>(text, params),
        drizzle: () => drizzle(client),
        close: () => client.end(),
      };
    },
  };
}

const CHUNK_SIZE = 500;
/** After this many failed runs a dead letter is parked: kept for a person to look at, no longer retried. */
const MAX_ATTEMPTS = 5;
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function ident(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`Invalid SQL identifier: ${name}`);
  return `"${name}"`;
}

// jsonb numbers lose precision past 2^53, so bigints (token amounts, balances) go in as strings.
const toJson = (value: unknown) =>
  JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v));

const schemaMismatch = (error: z.ZodError) =>
  `The call no longer matches the source's call schema. ${error.issues
    .map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
    .join("; ")}`;

/**
 * Every write to the warehouse: each source's raw table, the dead letters, and the run log.
 * The dead letters of every source share one table, <schema>._dead_letters, keyed by
 * (source_table, id). The run log is ops.ingestion_runs, which infra/postgres/ops.sql creates.
 *
 * Without `settings`, it reads the WAREHOUSE_* variables and RAW_SCHEMA when it first needs them,
 * so a missing one fails the run that needed it rather than the import.
 */
export function postgresWarehouse(settings?: WarehouseSettings) {
  return {
    async open(sourceTable: string) {
      const { schema, connect } = settings ?? postgresFromEnv();
      const raw = ident(schema);
      const table = `${raw}.${ident(sourceTable)}`;
      const deadLetters = `${raw}."_dead_letters"`;
      const db = await connect();
      try {
        await db.query(`create schema if not exists ${raw}`);
        await db.query(
          `create table if not exists ${table} (
             id text primary key,
             data jsonb not null,
             _loaded_at timestamptz not null default now()
           )`,
        );
        await db.query(
          `create table if not exists ${deadLetters} (
             source_table text not null,
             id text not null,
             call jsonb not null,
             error text not null,
             attempts integer not null default 1,
             parked boolean not null default false,
             first_failed_at timestamptz not null default now(),
             last_failed_at timestamptz not null default now(),
             primary key (source_table, id)
           )`,
        );
      } catch (error) {
        await db.close();
        throw error;
      }

      /** Writes the records, clears the dead letters they answer, and queues the new failures. */
      const write = async (q: Query, { records, failed, succeededCallIds = [] }: Batch) => {
        // Postgres rejects an upsert that touches the same id twice, so keep the last one.
        for (const part of chunk(uniqueBy(records, (r) => r.id), CHUNK_SIZE)) {
          await q.query(
            `insert into ${table} (id, data)
             select r->>'id', r->'data' from jsonb_array_elements($1::jsonb) r
             on conflict (id) do update set data = excluded.data, _loaded_at = now()`,
            [toJson(part)],
          );
        }
        const successfulCalls = [...new Set([...records.map((r) => r.callId), ...succeededCallIds])];
        if (successfulCalls.length > 0) {
          await q.query(`delete from ${deadLetters} where source_table = $1 and id = any($2::text[])`, [
            sourceTable,
            successfulCalls,
          ]);
        }
        for (const part of chunk(uniqueBy(failed, (f) => f.id), CHUNK_SIZE)) {
          await q.query(
            `insert into ${deadLetters} as t (source_table, id, call, error, parked)
             select $1, f->>'id', f->'call', f->>'error', $2::integer <= 1
             from jsonb_array_elements($3::jsonb) f
             on conflict (source_table, id) do update set
               call = excluded.call,
               error = excluded.error,
               attempts = t.attempts + 1,
               parked = t.attempts + 1 >= $2::integer,
               last_failed_at = now()`,
            [sourceTable, MAX_ATTEMPTS, toJson(part)],
          );
        }
      };

      return {
        name: table,
        deadLetters,

        /** The calls of the pending dead letters that still parse with `call`. The rest are parked, each with the reason. */
        async retries<C>(call: z.ZodType<C>): Promise<{ calls: C[]; parked: number }> {
          const { rows } = await db.query<{ id: string; call: unknown }>(
            `select id, call from ${deadLetters}
             where source_table = $1 and not parked
             order by first_failed_at, id`,
            [sourceTable],
          );
          const calls: C[] = [];
          const unparsed: { id: string; error: string }[] = [];
          for (const letter of rows) {
            const parsed = call.safeParse(letter.call);
            if (parsed.success) calls.push(parsed.data);
            else unparsed.push({ id: letter.id, error: schemaMismatch(parsed.error) });
          }
          if (unparsed.length > 0) {
            await db.query(
              `update ${deadLetters} as t set parked = true, error = l->>'error'
               from jsonb_array_elements($2::jsonb) l
               where t.source_table = $1 and t.id = l->>'id'`,
              [sourceTable, toJson(unparsed)],
            );
          }
          return { calls, parked: unparsed.length };
        },

        /** In one transaction: writes the records, clears the dead letters they answer, and queues the new failures. */
        async load(batch: Batch) {
          await db.query("begin");
          try {
            await write(db, batch);
            await db.query("commit");
          } catch (error) {
            // A connection that broke cannot roll back. Report the error that broke it instead.
            await db.query("rollback").catch(() => {});
            throw error;
          }
        },

        /**
         * The Pipes target a stream source is piped into. Pipes keeps the cursor and runs each
         * batch in one transaction, in which this table writes the batch like `load` does.
         */
        pipesTarget: (options: PipesTargetOptions) =>
          pipesTarget({ db: db.drizzle(), schema, id: sourceTable, write, ...options }),

        async backlog(): Promise<DeadLetterBacklog> {
          const { rows } = await db.query<DeadLetterBacklog>(
            `select count(*) filter (where not parked)::integer as pending,
                    count(*) filter (where parked)::integer as parked
             from ${deadLetters} where source_table = $1`,
            [sourceTable],
          );
          return rows[0]!;
        },

        close: () => db.close(),
      };
    },

    /**
     * Adds the run to ops.ingestion_runs, over a connection of its own so that a run whose
     * connection broke can still record that it failed. Never throws: a run that wrote its
     * records stays successful when its log row cannot be written.
     */
    async recordRun(report: RunReport, log: Logger): Promise<void> {
      try {
        const db = await (settings ?? postgresFromEnv()).connect();
        try {
          await db.query(
            `insert into ops.ingestion_runs (
               run_id, dagster_run_id, source, table_name, started_at, finished_at, succeeded,
               records_written, failed_calls, retried_calls, load_seconds,
               dead_letters_pending, dead_letters_parked, error
             ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            [
              report.runId,
              report.dagsterRunId ?? null,
              report.source,
              report.table,
              report.startedAt,
              report.finishedAt,
              report.error === undefined,
              report.recordsWritten,
              report.failedCalls,
              report.retriedCalls,
              report.loadSeconds,
              report.backlog?.pending ?? null,
              report.backlog?.parked ?? null,
              report.error ?? null,
            ],
          );
        } finally {
          await db.close();
        }
      } catch (error) {
        log.warn({ err: error }, "Could not record the run in ops.ingestion_runs");
      }
    },
  };
}
