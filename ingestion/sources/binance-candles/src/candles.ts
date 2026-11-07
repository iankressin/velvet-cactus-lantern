import { describeError, logger, type Batch, type RawRecord } from "@ingestion/lib";
import * as z from "zod";
import { BinanceError, type BinanceClient, type Candle, type Clock } from "#src/binance.ts";

// Binance's candle intervals of fixed length. 1s is left out, and a month (1M) has no fixed length.
const INTERVAL_MS = {
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "2h": 7_200_000,
  "4h": 14_400_000,
  "6h": 21_600_000,
  "8h": 28_800_000,
  "12h": 43_200_000,
  "1d": 86_400_000,
  "3d": 259_200_000,
  "1w": 604_800_000,
} as const;

export type Interval = keyof typeof INTERVAL_MS;

export const interval = z.enum(Object.keys(INTERVAL_MS) as [Interval, ...Interval[]]);

// The most candles Binance sends for one request.
const WINDOW_CANDLES = 1000;

const asset = z.string().regex(/^[A-Z0-9]+$/, {
  error: (issue) => `${JSON.stringify(issue.input)} is not a Binance asset: use capital letters and digits, such as UNI`,
});

const tokensFile = z.object({
  quote: asset,
  tokens: z.array(asset).min(1, "List at least one token"),
});

/** One token traded against the quote asset, such as UNIUSDT. */
export type Market = { symbol: string; base_asset: string; quote_asset: string };

export function parseTokens(json: unknown): Market[] {
  const parsed = tokensFile.safeParse(json);
  if (!parsed.success) throw new Error(`Invalid tokens.json:\n${z.prettifyError(parsed.error)}`);
  const { quote, tokens } = parsed.data;
  return [...new Set(tokens)].map((token) => ({
    symbol: token + quote,
    base_asset: token,
    quote_asset: quote,
  }));
}

const time = z.number().int().nonnegative();

/** One window of up to 1000 candles of one market. */
export const candleCallSchema = z.object({
  kind: z.literal("candles"),
  symbol: asset,
  base_asset: asset,
  quote_asset: asset,
  interval,
  start_time: time,
  end_time: time,
});

export type CandleCall = z.infer<typeof candleCallSchema>;

export const callId = (call: CandleCall) => `${call.symbol}:${call.interval}:${call.start_time}`;

/**
 * The open time of the market's first candle at or after `from`. It is where the market's
 * windows start, so none falls before a listing, and 3d and 1w windows stay on Binance's grid.
 * When the read fails for any reason but an unknown market or a ban, it returns `from`: the
 * market's windows still run, and any that fail wait as dead letters for the next run.
 */
export async function firstOpenTime(
  binance: BinanceClient,
  market: Market,
  interval: Interval,
  from: number,
): Promise<number> {
  let candles: Candle[];
  try {
    candles = await binance.candles({ symbol: market.symbol, interval, startTime: from, limit: 1 });
  } catch (error) {
    if (error instanceof BinanceError && error.invalidSymbol) {
      throw new Error(
        `Binance has no market ${market.symbol} for token ${market.base_asset} against ${market.quote_asset}. Fix tokens.json.`,
      );
    }
    if (error instanceof BinanceError && error.banned) throw error;
    logger.warn(
      { symbol: market.symbol, error: describeError(error) },
      "Could not read the market's first candle, so its windows start at START_TIME",
    );
    return from;
  }
  const [first] = candles;
  if (!first) {
    throw new Error(`Binance has no ${interval} candles of ${market.symbol} since START_TIME (${new Date(from).toISOString()})`);
  }
  return first.open_time;
}

/** The windows of the market from `first`, the last one starting at or before `now`. */
export function windowCalls(market: Market, interval: Interval, first: number, now: number): CandleCall[] {
  const span = WINDOW_CANDLES * INTERVAL_MS[interval];
  const calls: CandleCall[] = [];
  for (let start = first; start <= now; start += span) {
    calls.push({ kind: "candles", ...market, interval, start_time: start, end_time: start + span - 1 });
  }
  return calls;
}

const record = (call: CandleCall, candle: Candle): RawRecord => ({
  id: `${call.symbol}:${call.interval}:${candle.open_time}`,
  callId: callId(call),
  data: {
    symbol: call.symbol,
    base_asset: call.base_asset,
    quote_asset: call.quote_asset,
    interval: call.interval,
    ...candle,
  },
});

/**
 * Fetches every window at once. A window gives a record per closed candle, and one whose request
 * fails becomes a failed call for the next run. A ban fails the run, since more requests lengthen it.
 */
export async function fetchWindows(
  binance: BinanceClient,
  calls: readonly CandleCall[],
  clock: Clock,
): Promise<Batch<CandleCall>> {
  const outcomes = await Promise.allSettled(
    calls.map(async (call) => {
      // A candle still open when Binance answers still changes, even if it closes before the reply
      // arrives, so only candles closed before the request count. The first run after that loads it.
      const cutoff = clock.now();
      const candles = await binance.candles({
        symbol: call.symbol,
        interval: call.interval,
        startTime: call.start_time,
        endTime: call.end_time,
        limit: WINDOW_CANDLES,
      });
      return candles.filter((candle) => candle.close_time < cutoff);
    }),
  );
  const batch: Batch<CandleCall> = { records: [], failed: [] };
  calls.forEach((call, i) => {
    const outcome = outcomes[i]!;
    if (outcome.status === "fulfilled") {
      batch.records.push(...outcome.value.map((candle) => record(call, candle)));
    } else if (outcome.reason instanceof BinanceError && outcome.reason.banned) {
      throw outcome.reason;
    } else {
      batch.failed.push({ id: callId(call), call, error: describeError(outcome.reason) });
    }
  });
  return batch;
}
