import { runSource } from "@ingestion/lib";
import { binanceCandles } from "#src/source.ts";

await runSource(binanceCandles);
