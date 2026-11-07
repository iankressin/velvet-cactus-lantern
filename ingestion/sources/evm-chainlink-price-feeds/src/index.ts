import { runSource } from "@ingestion/lib";
import { chainName, forChain } from "#src/source.ts";

await runSource(forChain(chainName.parse(process.env.CHAIN)));
