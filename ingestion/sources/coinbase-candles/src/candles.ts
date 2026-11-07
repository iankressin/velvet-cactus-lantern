import { describeError, logger, type Batch, type RawRecord } from "@ingestion/lib";
import * as z from "zod";
import { CoinbaseError, type Candle, type Clock, type CoinbaseClient } from "#src/coinbase.ts";

// The candle lengths Coinbase offers, named as Binance names its intervals, so token_prices reads
// candles from both exchanges alike. Coinbase takes the length in seconds.
const INTERVAL_SECONDS = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "6h": 21600,
  "1d": 86400,
} as const;

export type Interval = keyof typeof INTERVAL_SECONDS;

export const interval = z.enum(Object.keys(INTERVAL_SECONDS) as [Interval, ...Interval[]]);

export const granularity = (interval: Interval) => INTERVAL_SECONDS[interval];

const intervalMs = (interval: Interval) => INTERVAL_SECONDS[interval] * 1000;

// The most candles Coinbase sends for one request. A wider range is an error, not a shorter reply.
const WINDOW_CANDLES = 300;

const asset = z.string().regex(/^[A-Z0-9]+$/, {
  error: (issue) => `${JSON.stringify(issue.input)} is not a Coinbase asset: use capital letters and digits, such as UNI`,
});

const tokensFile = z.object({
  quote: asset,
  tokens: z.array(asset).min(1, "List at least one token"),
});

/** One token traded against the quote asset, such as UNI-USD. */
export type Market = { product_id: string; base_asset: string; quote_asset: string };

export function parseTokens(json: unknown): Market[] {
  const parsed = tokensFile.safeParse(json);
  if (!parsed.success) throw new Error(`Invalid tokens.json:\n${z.prettifyError(parsed.error)}`);
  const { quote, tokens } = parsed.data;
  return [...new Set(tokens)].map((token) => ({
    product_id: `${token}-${quote}`,
    base_asset: token,
    quote_asset: quote,
  }));
}

const time = z.number().int().nonnegative();

/** One window of up to 300 candles of one market. */
export const candleCallSchema = z.object({
  kind: z.literal("candles"),
  product_id: z.string().regex(/^[A-Z0-9]+-[A-Z0-9]+$/),
  base_asset: asset,
  quote_asset: asset,
  interval,
  start_time: time,
  end_time: time,
});

export type CandleCall = z.infer<typeof candleCallSchema>;

export const callId = (call: CandleCall) => `${call.product_id}:${call.interval}:${call.start_time}`;

/**
 * Checks that Coinbase lists the market. An unknown product fails the run and names the token, so
 * a typo in tokens.json is caught before any window is requested. A market that is not trading
 * only warns: its candles up to the halt still load. When the check fails for any other reason,
 * the market's windows still run, and any that fail wait as dead letters for the next run.
 */
export async function checkMarket(coinbase: CoinbaseClient, market: Market): Promise<void> {
  try {
    const product = await coinbase.product(market.product_id);
    if (product.status !== "online" || product.trading_disabled) {
      logger.warn(
        { productId: market.product_id, status: product.status, tradingDisabled: product.trading_disabled },
        "The market is not trading on Coinbase, so only the candles before its halt load",
      );
    }
  } catch (error) {
    if (error instanceof CoinbaseError && error.notFound) {
      throw new Error(
        `Coinbase has no market ${market.product_id} for token ${market.base_asset} against ${market.quote_asset}. Fix tokens.json.`,
      );
    }
    logger.warn(
      { productId: market.product_id, error: describeError(error) },
      "Could not check the market on Coinbase, so its windows run unchecked",
    );
  }
}

/** The start of the candle that holds `time`. Coinbase's buckets sit on the epoch grid, in UTC. */
export const bucketStart = (time: number, interval: Interval) => time - (time % intervalMs(interval));

/**
 * The windows of the market from the candle that holds `from`, the last one starting at or before
 * `now`. Each covers 300 candles, so its request stays inside Coinbase's limit.
 */
export function windowCalls(market: Market, interval: Interval, from: number, now: number): CandleCall[] {
  const span = WINDOW_CANDLES * intervalMs(interval);
  const calls: CandleCall[] = [];
  for (let start = bucketStart(from, interval); start <= now; start += span) {
    calls.push({ kind: "candles", ...market, interval, start_time: start, end_time: start + span - 1 });
  }
  return calls;
}

const record = (call: CandleCall, candle: Candle): RawRecord => {
  const open_time = candle.time * 1000;
  return {
    id: `${call.product_id}:${call.interval}:${open_time}`,
    callId: callId(call),
    data: {
      product_id: call.product_id,
      base_asset: call.base_asset,
      quote_asset: call.quote_asset,
      interval: call.interval,
      open_time,
      close_time: open_time + intervalMs(call.interval) - 1,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
    },
  };
};

/**
 * Fetches every window at once. A window gives a record per closed candle in it, and one whose
 * request fails, a rate limit the client's retries did not clear included, becomes a failed call
 * for the next run.
 */
export async function fetchWindows(
  coinbase: CoinbaseClient,
  calls: readonly CandleCall[],
  clock: Clock,
): Promise<Batch<CandleCall>> {
  const outcomes = await Promise.allSettled(
    calls.map(async (call) => {
      // The candle still open when Coinbase answers still changes, even if it closes before the
      // reply arrives, so only candles closed before the request count. The next run loads it.
      // Coinbase's range ends are not documented as exclusive, so a candle outside the window is
      // dropped too, instead of landing under the wrong call.
      const cutoff = clock.now();
      const candles = await coinbase.candles({
        productId: call.product_id,
        granularity: granularity(call.interval),
        startTime: call.start_time,
        endTime: call.end_time,
      });
      return candles.filter(({ time }) => {
        const open = time * 1000;
        return open >= call.start_time && open <= call.end_time && open + intervalMs(call.interval) <= cutoff;
      });
    }),
  );
  const succeededCallIds: string[] = [];
  const batch: Batch<CandleCall> = { records: [], failed: [], succeededCallIds };
  calls.forEach((call, i) => {
    const outcome = outcomes[i]!;
    if (outcome.status === "fulfilled") {
      succeededCallIds.push(callId(call));
      batch.records.push(...outcome.value.map((candle) => record(call, candle)));
    } else {
      batch.failed.push({ id: callId(call), call, error: describeError(outcome.reason) });
    }
  });
  return batch;
}
