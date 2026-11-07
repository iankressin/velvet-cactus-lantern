import { runSource } from "@ingestion/lib";
import { bitcoinBtcBalances } from "#src/source.ts";

await runSource(bitcoinBtcBalances);
