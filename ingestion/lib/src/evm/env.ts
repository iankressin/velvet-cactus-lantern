import * as z from "zod";

export const blockNumber = z.union(
  [
    z.enum(["latest", "safe", "finalized"]),
    z
      .string()
      .regex(/^\d+$/)
      .transform(Number)
      .pipe(z.number().max(Number.MAX_SAFE_INTEGER)),
  ],
  {
    error: (issue) =>
      issue.input === undefined
        ? "Required"
        : "Expected a block number, or latest, safe or finalized",
  },
);

export type BlockNumber = z.infer<typeof blockNumber>;

export const evmEnv = z.object({
  BLOCK_NUMBER: blockNumber,
  EVM_RPC_URL: z.url(),
  RPC_BATCH_SIZE: z.coerce.number().int().positive().default(100),
  // Most HTTP requests in flight at once. Public RPCs time out or answer 429 well below the default.
  RPC_MAX_CONCURRENCY: z.coerce.number().int().positive().default(16),
});

export type EvmEnv = z.infer<typeof evmEnv>;
