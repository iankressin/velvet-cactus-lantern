import { runSource } from "@ingestion/lib";
import { solanaSplMetadata } from "#src/source.ts";

await runSource(solanaSplMetadata);
