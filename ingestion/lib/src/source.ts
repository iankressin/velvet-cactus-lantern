import type * as z from "zod";

export type RawRecord = {
  /** The row's key. It can add what only the reply knows, such as the slot a Solana read landed on. */
  id: string;
  /** The id of the call this record answers. A success clears the dead letter with this id. */
  callId: string;
  data: Record<string, unknown>;
};

/** A call that failed after the transport's own retries. `call` holds what is needed to make it again. */
export type Failed<C = unknown> = {
  id: string;
  call: C;
  error: string;
};

export type Batch<C = unknown> = {
  records: RawRecord[];
  failed: Failed<C>[];
  /** Successful calls can clear their dead letters even when they produced no records. */
  succeededCallIds?: string[];
};

/**
 * A source that makes calls, such as RPC reads at one block.
 *
 * `name` and `table` must match the dbt source name and table name.
 * Dagster uses the pair as the asset key, which links each ingestion
 * asset to the dbt models that read from it.
 *
 * `retry` holds the calls that failed in earlier runs, parsed with `call`. A source makes
 * them again next to its new calls. A failed call's `id` is the `callId` of the record it
 * would have produced, which is how a success clears its dead letter. A batch can also report
 * successful call ids when a call produces no records. A dead letter whose call no longer
 * parses is parked.
 */
export interface Source<E, C> {
  name: string;
  table: string;
  env: z.ZodType<E>;
  call: z.ZodType<C>;
  extract(env: E, retry: C[]): AsyncIterable<Batch<C>>;
}
