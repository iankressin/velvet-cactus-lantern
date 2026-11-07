import type { PortalBatch, Target, TargetState } from "@subsquid/pipes";
import { drizzleTarget, type Transaction } from "@subsquid/pipes/targets/drizzle/node-postgres";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Batch, StreamRecords } from "#src/source.ts";
import type { Query } from "#src/warehouse/index.ts";

export type PipesTargetOptions = {
  /** About this many blocks a run: the run ends on the batch that passes it. */
  maxBlocks: number;
  onLoad(load: { records: number; seconds: number }): void;
};

/**
 * Pipes' own Postgres target, with the warehouse writing the rows. Pipes keeps the cursor in
 * <schema>._sync, keyed by the source table, and wraps each batch in one transaction; `write`
 * runs the warehouse's statements inside it. Rows and cursor commit together, and the next
 * run resumes after the last block that committed.
 *
 * It reads finalized blocks only. No fork can reach it, so it gives Pipes no tables to track
 * for rollback, and Pipes adds no triggers or snapshot tables to the raw tables.
 */
export function pipesTarget({
  db,
  schema,
  id,
  write,
  maxBlocks,
  onLoad,
}: PipesTargetOptions & {
  db: NodePgDatabase;
  schema: string;
  id: string;
  write(q: Query, batch: Batch): Promise<void>;
}): Target<StreamRecords> {
  const pipes = drizzleTarget<StreamRecords>({
    db,
    tables: [],
    settings: { state: { schema, table: "_sync", id } },
    onData: async ({ tx, data }) => {
      const records = Array.isArray(data) ? data : Object.values(data).flat();
      const startedAt = performance.now();
      await write(within(tx), { records, failed: [] });
      onLoad({ records: records.length, seconds: (performance.now() - startedAt) / 1000 });
    },
  });
  return {
    ...pipes,
    requiresFinalizedStream: true,
    write: (writer) =>
      pipes.write({ ...writer, read: (state, options) => upTo(maxBlocks, state, writer.read(state, options)) }),
  };
}

/** The warehouse's statements, run in a Pipes transaction. Each `$n` becomes a bound value; `sql.param` keeps an array one value. */
const within = (tx: Transaction): Query => ({
  async query<R>(text: string, params: unknown[] = []) {
    const parts = text.split(/\$(\d+)/);
    const query = sql.join(parts.map((part, i) => (i % 2 ? sql.param(params[Number(part) - 1]) : sql.raw(part))));
    const { rows } = await tx.execute(query);
    return { rows: rows as R[] };
  },
});

/** Passes batches on until the run has read `maxBlocks` blocks, then ends the stream. */
async function* upTo<T>(maxBlocks: number, state: TargetState | undefined, batches: AsyncIterable<PortalBatch<T>>) {
  for await (const batch of batches) {
    yield batch;
    const { initial, current } = batch.ctx.stream.state;
    const start = state ? state.latest.number + 1 : initial;
    if (current.number - start + 1 >= maxBlocks) return;
  }
}
