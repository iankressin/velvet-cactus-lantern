import { chunk, uniqueBy, type Source } from "@ingestion/lib";
import * as z from "zod";
import { createBinanceClient, systemClock, type Clock } from "#src/binance.ts";
import {
  callId,
  fetchWindows,
  firstOpenTime,
  interval,
  candleCallSchema,
  parseTokens,
  windowCalls,
  type CandleCall,
} from "#src/candles.ts";

const startTime = z
  .union([z.iso.date(), z.iso.datetime({ offset: true })], {
    error: (issue) =>
      issue.input === undefined
        ? "Required"
        : "Expected an ISO date or datetime, such as 2026-10-01 or 2026-10-01T00:00:00Z",
  })
  .transform((value) => Date.parse(value));

const binanceEnv = z.object({
  // Binance's market-data-only host. api.binance.com refuses requests from some regions.
  BINANCE_API_URL: z.url().default("https://data-api.binance.vision"),
  CANDLE_INTERVAL: interval.default("1h"),
  START_TIME: startTime,
  // A chunk sends this many requests of weight 2 at once after the weight check, so it must fit in the
  // 1000 weight between the client's 5000 budget and Binance's limit of 6000.
  BINANCE_MAX_CONCURRENCY: z.coerce.number().int().positive().max(100).default(5),
});

export type BinanceEnv = z.infer<typeof binanceEnv>;

// Every closed candle of each token in tokens.json since START_TIME, one window of up to 1000
// candles per call, plus the windows that failed in earlier runs.
export const candlesSource = (clock: Clock = systemClock): Source<BinanceEnv, CandleCall> => ({
  name: "binance",
  table: "candles",
  env: binanceEnv,
  call: candleCallSchema,
  async *extract(env, retry) {
    // Read inside the run, not at import, so runSource reports a bad tokens.json.
    const { default: tokens } = await import("../tokens.json", { with: { type: "json" } });
    const markets = parseTokens(tokens);
    const binance = createBinanceClient(env.BINANCE_API_URL, clock);

    const firsts: number[] = [];
    for (const part of chunk(markets, env.BINANCE_MAX_CONCURRENCY)) {
      await binance.waitForWeight();
      firsts.push(
        ...(await Promise.all(
          part.map((market) => firstOpenTime(binance, market, env.CANDLE_INTERVAL, env.START_TIME)),
        )),
      );
    }
    const now = clock.now();
    const calls = markets.flatMap((market, i) => windowCalls(market, env.CANDLE_INTERVAL, firsts[i]!, now));

    // A new call comes after its retried twin, so it is the one kept.
    for (const part of chunk(uniqueBy([...retry, ...calls], callId), env.BINANCE_MAX_CONCURRENCY)) {
      await binance.waitForWeight();
      yield await fetchWindows(binance, part, clock);
    }
  },
});

export const binanceCandles = candlesSource();
