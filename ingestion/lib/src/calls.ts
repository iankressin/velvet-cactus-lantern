import { BaseError } from "viem";
import type { Batch } from "#src/source.ts";

export function describeError(error: unknown): string {
  if (error instanceof BaseError) {
    return error.details ? `${error.shortMessage} ${error.details}` : error.shortMessage;
  }
  // Node reports a refused connection to localhost, tried on IPv6 and IPv4, as an AggregateError
  // with an empty message and the two errors inside.
  if (error instanceof AggregateError && !error.message) {
    return error.errors.map(describeError).join("; ");
  }
  return error instanceof Error ? error.message || error.name : String(error);
}

export function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...new Map(items.map((item) => [key(item), item])).values()];
}

export const chunk = <T>(items: readonly T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, (i + 1) * size),
  );

/**
 * Makes each distinct call once. A call that resolves becomes a record, one that rejects
 * becomes a failed call for the next run. Both carry the call's id, and `rowId` sets the
 * record's own id when the reply adds to it. Every `read` starts in the same tick, which
 * is what lets the RPC clients batch them.
 */
export async function settleCalls<C, D extends Record<string, unknown>>(
  calls: readonly C[],
  id: (call: C) => string,
  read: (call: C) => Promise<D>,
  rowId: (call: C, data: D) => string = id,
): Promise<Batch<C>> {
  const unique = uniqueBy(calls, id);
  const outcomes = await Promise.allSettled(unique.map((call) => read(call)));
  const batch: Batch<C> = { records: [], failed: [] };
  unique.forEach((call, i) => {
    const outcome = outcomes[i]!;
    if (outcome.status === "fulfilled")
      batch.records.push({ id: rowId(call, outcome.value), callId: id(call), data: outcome.value });
    else batch.failed.push({ id: id(call), call, error: describeError(outcome.reason) });
  });
  return batch;
}
