import { runSource } from "@ingestion/lib";
import { solanaSolBalances } from "#src/source.ts";

await runSource(solanaSolBalances);
