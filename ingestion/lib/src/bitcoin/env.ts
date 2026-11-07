import * as z from "zod";

export const bitcoinEnv = z.object({ DSHACKLE_URL: z.url() });

export type BitcoinEnv = z.infer<typeof bitcoinEnv>;
