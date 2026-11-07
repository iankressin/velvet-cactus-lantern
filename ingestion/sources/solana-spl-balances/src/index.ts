import { runSource } from "@ingestion/lib";
import { solanaSplBalances } from "#src/source.ts";

await runSource(solanaSplBalances);
