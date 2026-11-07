import * as z from "zod";
import type { Blockchain } from "#src/wallet-assets/wallet-assets.ts";

/**
 * The wallet asset CSV a balance source reads, by its path from the source's package folder. The
 * default is the one file every balance source shares, ingestion/wallet-assets.csv, so an .env written
 * before the setting existed still works.
 */
export const walletAssetsEnv = z.object({
  WALLET_ASSETS_CSV: z.string().default("../../wallet-assets.csv"),
});

export type WalletAssetsEnv = z.infer<typeof walletAssetsEnv>;

/**
 * The EVM chains a wallet asset CSV can name. An EVM source runs once per folder in its chains/ and
 * parses its CHAIN with this inside the run, so a chain the CSV cannot hold yet fails only that run.
 */
export const evmBlockchain = z.enum(["ethereum"]) satisfies z.ZodType<Blockchain>;
