import { pino } from "pino";
import pretty from "pino-pretty";
import * as z from "zod";
import { loadEnv } from "#src/env.ts";

const levels = z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]);
const { LOG_LEVEL = "info" } = loadEnv(z.object({ LOG_LEVEL: z.string().optional() }));
const level = levels.safeParse(LOG_LEVEL);

/**
 * JSON lines on stdout, which Dagster parses into log events at the matching level.
 * A person running a source in a terminal gets readable lines instead.
 */
export const logger = pino(
  { level: level.data ?? "info" },
  process.stdout.isTTY ? pretty({ sync: true }) : pino.destination({ sync: true }),
);

// runSource reports every failure through this logger, so a bad LOG_LEVEL must not stop it
// from loading. Like a bad PUSHGATEWAY_URL, it only warns.
if (!level.success) {
  logger.warn(
    { LOG_LEVEL },
    `LOG_LEVEL must be one of ${levels.options.join(", ")}, so the logger uses info`,
  );
}

export type Logger = typeof logger;
