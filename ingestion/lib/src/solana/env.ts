import * as z from "zod";

export const solanaEnv = z.object({ SOLANA_RPC_URL: z.url() });

export type SolanaEnv = z.infer<typeof solanaEnv>;
