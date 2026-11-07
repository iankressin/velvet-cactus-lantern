import { readFileSync } from "node:fs";

/**
 * The JSON in a file, by its path from the working directory, the package's folder when a source
 * runs, as for its .env. Call it inside a run, so a bad file fails the run and runSource logs why.
 */
export function readJson(path: string): any {
  const text = readFileSync(path, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
  }
}
