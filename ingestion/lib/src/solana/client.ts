import { setTimeout as sleep } from "node:timers/promises";
import {
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  isSolanaError,
  type RpcTransport,
} from "@solana/kit";
import * as kit from "@solana/kit";
import { createLimiter } from "#src/concurrency.ts";

export type SolanaClient = ReturnType<typeof createSolanaClient>;

export type SolanaClientOptions = {
  maxConcurrency?: number;
  retryCount?: number;
};

// eRPC sends an HTTP error only after its own retries across every upstream; sending the
// request again repeats all of that work against upstreams that are already refusing.
const retryable = (error: unknown) =>
  !isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR);

async function withRetry<T>(request: () => Promise<T>, retryCount: number): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await request();
    } catch (error) {
      if (attempt >= retryCount || !retryable(error)) throw error;
      await sleep(150 * 2 ** attempt);
    }
  }
}

// @solana/errors 8.6 throws a TypeError, losing the reply, when it builds a SolanaError for a
// code it has no message for, such as eRPC's -32000. Fixed in anza-xyz/kit#2163, not yet released.
const namedRpcCodes = new Set<unknown>(
  Object.entries(kit)
    .filter(([name]) => name.startsWith("SOLANA_ERROR__JSON_RPC__"))
    .map(([, code]) => code),
);

function throwUnnamedRpcError(reply: unknown) {
  const { error } = reply as { error?: { code: bigint; message: string } };
  if (error && !namedRpcCodes.has(Number(error.code))) {
    throw new Error(`JSON-RPC error ${error.code}: ${error.message}`, { cause: error });
  }
}

/**
 * Sends at most `maxConcurrency` requests at once, and retries a request that got no reply,
 * such as while eRPC restarts, with exponential backoff. Any reply, an HTTP error or a
 * JSON-RPC error inside it, goes to the caller.
 *
 * Solana RPCs serve only current state: reads take a commitment, not a slot, and each
 * reply's `context.slot` says which slot it was read at.
 */
export function createSolanaClient(
  url: string,
  { maxConcurrency = 16, retryCount = 5 }: SolanaClientOptions = {},
) {
  const send = createDefaultRpcTransport({ url });
  const limit = createLimiter(maxConcurrency);
  const transport: RpcTransport = async <T>(config: Parameters<RpcTransport>[0]) => {
    const reply = await limit(() => withRetry(() => send<T>(config), retryCount));
    throwUnnamedRpcError(reply);
    return reply;
  };

  return createSolanaRpcFromTransport(transport);
}
