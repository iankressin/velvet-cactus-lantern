import { setTimeout } from "node:timers/promises";
import { logger } from "@ingestion/lib";
import * as z from "zod";

/** Time as the client sees it, so a test can pass a minute's wait at once. */
export type Clock = { now(): number; sleep(ms: number): Promise<void> };

export const systemClock: Clock = { now: () => Date.now(), sleep: (ms) => setTimeout(ms) };

// Binance allows 6000 request weight a minute per IP and resets the count when a minute starts.
const WEIGHT_BUDGET = 5000;
const MINUTE_MS = 60_000;
const TIMEOUT_MS = 30_000;

// Binance sends a candle as an array in this order. The twelfth field is unused.
const candle = z
  .tuple(
    [
      z.number(),
      z.string(),
      z.string(),
      z.string(),
      z.string(),
      z.string(),
      z.number(),
      z.string(),
      z.number(),
      z.string(),
      z.string(),
    ],
    z.unknown(),
  )
  .transform(
    ([
      open_time,
      open,
      high,
      low,
      close,
      volume,
      close_time,
      quote_volume,
      trades,
      taker_buy_base_volume,
      taker_buy_quote_volume,
    ]) => ({
      open_time,
      open,
      high,
      low,
      close,
      volume,
      close_time,
      quote_volume,
      trades,
      taker_buy_base_volume,
      taker_buy_quote_volume,
    }),
  );

export type Candle = z.output<typeof candle>;

const errorBody = z.object({ code: z.number(), msg: z.string() });

export class BinanceError extends Error {
  readonly status: number;
  readonly code: number | undefined;

  constructor(status: number, code: number | undefined, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }

  get banned() {
    return this.status === 418;
  }

  get invalidSymbol() {
    return this.code === -1121;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function binanceError(response: Response): Promise<BinanceError> {
  const text = await response.text();
  const body = errorBody.safeParse(parseJson(text));
  const detail = body.success
    ? `Binance answered HTTP ${response.status} with code ${body.data.code}: ${body.data.msg}`
    : `Binance answered HTTP ${response.status}: ${text}`;
  return new BinanceError(
    response.status,
    body.data?.code,
    response.status === 418
      ? `Binance banned this IP for sending too many requests, and more requests lengthen the ban. ${detail}`
      : detail,
  );
}

export type BinanceClient = ReturnType<typeof createBinanceClient>;

/** Reads Binance's public market data at `url`, keeping count of the request weight used this minute. */
export function createBinanceClient(url: string, clock: Clock) {
  let usedWeight = 0;

  return {
    /** Candles from `startTime` on, oldest first: at most `limit`, and none that open after `endTime`. */
    async candles(query: {
      symbol: string;
      interval: string;
      startTime: number;
      endTime?: number;
      limit: number;
    }): Promise<Candle[]> {
      const request = new URL("/api/v3/klines", url);
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) request.searchParams.set(key, String(value));
      }
      const response = await fetch(request, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      const weight = response.headers.get("x-mbx-used-weight-1m");
      if (weight !== null) usedWeight = Number(weight);
      if (!response.ok) throw await binanceError(response);
      const candles = z.array(candle).safeParse(await response.json());
      if (!candles.success) {
        throw new Error(`Binance sent candles in an unexpected shape:\n${z.prettifyError(candles.error)}`);
      }
      return candles.data;
    },

    /** Waits for the next minute when this one's weight is spent. Call it before each set of requests sent together. */
    async waitForWeight() {
      if (usedWeight < WEIGHT_BUDGET) return;
      const waitMs = MINUTE_MS - (clock.now() % MINUTE_MS);
      logger.info({ usedWeight, waitMs }, "Binance request weight is near its limit, waiting for the next minute");
      await clock.sleep(waitMs);
      usedWeight = 0;
    },
  };
}
