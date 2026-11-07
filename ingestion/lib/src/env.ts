import { config } from "dotenv";
import * as z from "zod";

/**
 * Reads the env files in the working directory, then validates process.env. An empty value counts
 * as unset. A value already in the environment wins over every file. In a package that loads several
 * chains, the folder of the chain in CHAIN comes next, chains/<CHAIN>/.env and then its .env.example,
 * and the package's .env last. Only the environment sets CHAIN: a CHAIN in a file is dropped, so a
 * stale one cannot point a run at another chain's table.
 */
export function loadEnv<T extends z.ZodType>(schema: T): z.infer<T> {
  const chain = process.env.CHAIN;
  const chainFiles = chain ? [`chains/${chain}/.env`, `chains/${chain}/.env.example`] : [];
  config({ path: [...chainFiles, ".env"], quiet: true });
  if (chain === undefined) delete process.env.CHAIN;
  const values = Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => v !== ""),
  );
  const result = schema.safeParse(values);
  if (!result.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
