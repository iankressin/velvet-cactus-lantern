import { runSource } from "@ingestion/lib";
import { chainName, forChain } from "#src/source.ts";

// Dagster sets CHAIN to the chain of the asset it runs; by hand, run `CHAIN=base pnpm ingest`. The
// run reads that chain's settings from chains/<chain>/, which win over the package's .env.
await runSource(forChain(chainName.parse(process.env.CHAIN)));
