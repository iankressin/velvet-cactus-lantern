import { chunk, uniqueBy, type Source } from "@ingestion/lib";
import * as z from "zod";
import { createCoinbaseClient, systemClock, type Clock } from "#src/coinbase.ts";
import {
  callId,
  candleCallSchema,
  checkMarket,
  fetchWindows,
  interval,
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

const coinbaseEnv = z.object({
  // Coinbase Exchange's public market-data API, which needs no key.
  COINBASE_API_URL: z.url().default("https://api.exchange.coinbase.com"),
  CANDLE_INTERVAL: interval.default("1h"),
  START_TIME: startTime,
  // A chunk sends this many requests at once, one chunk a second, so it must stay within Coinbase's
  // 10 public requests a second.
  COINBASE_MAX_CONCURRENCY: z.coerce.number().int().positive().max(10).default(5),
});

export type CoinbaseEnv = z.infer<typeof coinbaseEnv>;

// Every closed candle of each token in tokens.json since START_TIME, one window of up to 300
// candles per call, plus the windows that failed in earlier runs.
export const candlesSource = (clock: Clock = systemClock): Source<CoinbaseEnv, CandleCall> => ({
  name: "coinbase",
  table: "candles",
  env: coinbaseEnv,
  call: candleCallSchema,
  async *extract(env, retry) {
    // Read inside the run, not at import, so runSource reports a bad tokens.json.
    const { default: tokens } = await import("../tokens.json", { with: { type: "json" } });
    const markets = parseTokens(tokens);
    const coinbase = createCoinbaseClient(env.COINBASE_API_URL, clock);

    for (const part of chunk(markets, env.COINBASE_MAX_CONCURRENCY)) {
      await coinbase.waitForRate();
      await Promise.all(part.map((market) => checkMarket(coinbase, market)));
    }
    const now = clock.now();
    const calls = markets.flatMap((market) => windowCalls(market, env.CANDLE_INTERVAL, env.START_TIME, now));

    // A new call comes after its retried twin, so it is the one kept.
    for (const part of chunk(uniqueBy([...retry, ...calls], callId), env.COINBASE_MAX_CONCURRENCY)) {
      await coinbase.waitForRate();
      yield await fetchWindows(coinbase, part, clock);
    }
  },
});

export const coinbaseCandles = candlesSource();
