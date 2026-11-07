import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/** Loads the logger in a fresh process with `LOG_LEVEL`, logs at debug and info, and returns the JSON lines. */
function logWith(LOG_LEVEL: string) {
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `import { logger } from "#src/logger.ts"; logger.debug("debug line"); logger.info("info line");`,
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, LOG_LEVEL },
      encoding: "utf8",
    },
  );
  assert.equal(child.status, 0, child.stderr);
  return child.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { level: number; msg: string; LOG_LEVEL?: string });
}

test("an invalid LOG_LEVEL warns and falls back to info instead of crashing the import", () => {
  const lines = logWith("loud");
  assert.deepEqual(
    lines.map(({ level, msg, LOG_LEVEL }) => ({ level, msg, LOG_LEVEL })),
    [
      {
        level: 40,
        msg: "LOG_LEVEL must be one of trace, debug, info, warn, error, fatal, silent, so the logger uses info",
        LOG_LEVEL: "loud",
      },
      { level: 30, msg: "info line", LOG_LEVEL: undefined },
    ],
  );
});

test("a valid LOG_LEVEL is used as is, with no warning", () => {
  assert.deepEqual(
    logWith("debug").map(({ level, msg }) => ({ level, msg })),
    [
      { level: 20, msg: "debug line" },
      { level: 30, msg: "info line" },
    ],
  );
});
