import { runSource } from "@ingestion/lib";
import { inputWalletAssets } from "#src/source.ts";

await runSource(inputWalletAssets);
