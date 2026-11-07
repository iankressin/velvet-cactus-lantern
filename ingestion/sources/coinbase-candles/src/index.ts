import { runSource } from "@ingestion/lib";
import { coinbaseCandles } from "#src/source.ts";

await runSource(coinbaseCandles);
