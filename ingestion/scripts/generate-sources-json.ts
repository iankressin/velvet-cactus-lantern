/**
 * Writes ingestion/sources.json: the exported `name` and `table` of every source package, with its
 * folder under ingestion/sources/, sorted by name then table. Dagster builds its SOURCES from this
 * file, and the orchestration tests fail when it falls behind the code.
 *
 * Run it with `pnpm generate-sources` from ingestion/ after adding or renaming a source. An optional
 * argument writes the list somewhere else, which is how the freshness test compares it.
 *
 * It imports each package's src/source.ts, which must be free of side effects, and never src/index.ts,
 * which runs the source. The export's name varies by package, so the Source is found by shape.
 *
 * A package with a chains/ folder loads one table on each chain in it. Its src/source.ts exports
 * `forChain(chain)`, which returns that chain's Source, and the generator calls it once per folder in
 * chains/. Each entry also records `settings`, the chain's folder in the package, which holds its
 * .env.example and addresses.json; Dagster passes the chain to the run as CHAIN.
 */

import { readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

type SourceEntry = { name: string; table: string; package: string; settings?: string };

const ingestionDir = path.resolve(import.meta.dirname, "..");
const sourcesDir = path.join(ingestionDir, "sources");
const out = path.resolve(process.argv[2] ?? path.join(ingestionDir, "sources.json"));

function isSource(value: unknown): value is { name: string; table: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { name?: unknown }).name === "string" &&
    typeof (value as { table?: unknown }).table === "string"
  );
}

async function folders(dir: string): Promise<string[]> {
  return (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}

const isDir = (dir: string) => stat(dir).then((s) => s.isDirectory(), () => false);

async function sourcesOf(pkg: string): Promise<SourceEntry[]> {
  const file = path.join(sourcesDir, pkg, "src", "source.ts");
  const label = path.relative(ingestionDir, file);
  const exports: Record<string, unknown> = await import(pathToFileURL(file).href);
  const chainsDir = path.join(sourcesDir, pkg, "chains");
  if (await isDir(chainsDir)) {
    const { forChain } = exports;
    if (typeof forChain !== "function") {
      throw new Error(`${label} must export forChain(chain), because ${pkg} has a chains/ folder`);
    }
    const chains = await folders(chainsDir);
    if (chains.length === 0) throw new Error(`sources/${pkg}/chains/ has no chain folders`);
    return chains.map((chain) => {
      const source: unknown = forChain(chain);
      if (!isSource(source) || source.name !== chain) {
        throw new Error(`forChain("${chain}") in ${label} must return a Source named ${chain}`);
      }
      return { name: source.name, table: source.table, package: pkg, settings: `chains/${chain}` };
    });
  }
  const sources = Object.entries(exports).filter(([, value]) => isSource(value));
  if (sources.length !== 1) {
    const found = sources.map(([key]) => key).join(", ") || "none";
    throw new Error(`${label} must export exactly one Source, found ${found}`);
  }
  const [[, source]] = sources as [[string, { name: string; table: string }]];
  return [{ name: source.name, table: source.table, package: pkg }];
}

const entries: SourceEntry[] = [];
for (const pkg of await folders(sourcesDir)) {
  entries.push(...(await sourcesOf(pkg)));
}
entries.sort((a, b) => a.name.localeCompare(b.name) || a.table.localeCompare(b.table));

const seen = new Map<string, string>();
for (const { name, table, package: pkg } of entries) {
  const key = `${name}.${table}`;
  const other = seen.get(key);
  if (other) throw new Error(`${other} and ${pkg} both export ${key}`);
  seen.set(key, pkg);
}

await writeFile(out, JSON.stringify(entries, null, 2) + "\n");
console.log(`wrote ${entries.length} sources to ${path.relative(process.cwd(), out) || out}`);
