import { setTimeout } from "node:timers/promises";
import { logger } from "@ingestion/lib";
import * as z from "zod";

/** Time as the client sees it, so a test can pass a second's wait at once. */
export type Clock = { now(): number; sleep(ms: number): Promise<void> };

export const systemClock: Clock = { now: () => Date.now(), sleep: (ms) => setTimeout(ms) };

// Coinbase allows 10 public requests a second per IP, with short bursts above that, and answers
// HTTP 429 beyond it. It sends no header with the count used, so the client paces itself: one chunk
// of requests a second, and a request that gets 429 waits and tries again.
const SECOND_MS = 1000;
const RETRY_WAITS_MS = [1000, 2000];
const TIMEOUT_MS = 30_000;

// Coinbase sends a candle as an array in this order. time is the bucket's start, in epoch seconds.
const candle = z
  .tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number()])
  .transform(([time, low, high, open, close, volume]) => ({ time, low, high, open, close, volume }));

export type Candle = z.output<typeof candle>;

const product = z.object({
  id: z.string(),
  base_currency: z.string(),
  quote_currency: z.string(),
  status: z.string(),
  trading_disabled: z.boolean().optional(),
});

export type Product = z.output<typeof product>;

const errorBody = z.object({ message: z.string() });

export class CoinbaseError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }

  get notFound() {
    return this.status === 404;
  }

  get rateLimited() {
    return this.status === 429;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function coinbaseError(response: Response): Promise<CoinbaseError> {
  const text = await response.text();
  const body = errorBody.safeParse(parseJson(text));
  return new CoinbaseError(
    response.status,
    `Coinbase answered HTTP ${response.status}: ${body.success ? body.data.message : text}`,
  );
}

export type CoinbaseClient = ReturnType<typeof createCoinbaseClient>;

/** Reads Coinbase Exchange's public market data at `url`, one chunk of requests a second. */
export function createCoinbaseClient(url: string, clock: Clock) {
  let lastChunkAt = -Infinity;

  async function get(path: string, query: Record<string, string> = {}): Promise<unknown> {
    const request = new URL(path, url);
    for (const [key, value] of Object.entries(query)) request.searchParams.set(key, value);
    for (let attempt = 0; ; attempt++) {
      lastChunkAt = clock.now();
      const response = await fetch(request, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (response.ok) return response.json();
      const error = await coinbaseError(response);
      const waitMs = RETRY_WAITS_MS[attempt];
      if (!error.rateLimited || waitMs === undefined) throw error;
      logger.info({ path, waitMs }, "Coinbase rate limit reached, waiting before trying again");
      await clock.sleep(waitMs);
    }
  }

  return {
    /** The product, such as UNI-USD. An unknown one gets a CoinbaseError whose `notFound` is true. */
    async product(id: string): Promise<Product> {
      const parsed = product.safeParse(await get(`/products/${id}`));
      if (!parsed.success) {
        throw new Error(`Coinbase sent product ${id} in an unexpected shape:\n${z.prettifyError(parsed.error)}`);
      }
      return parsed.data;
    },

    /**
     * Candles of `granularity` seconds whose buckets start between `startTime` and `endTime` (epoch
     * milliseconds), oldest first. Coinbase sends at most 300 and leaves out buckets with no trades.
     */
    async candles(query: {
      productId: string;
      granularity: number;
      startTime: number;
      endTime: number;
    }): Promise<Candle[]> {
      const body = await get(`/products/${query.productId}/candles`, {
        granularity: String(query.granularity),
        start: new Date(query.startTime).toISOString(),
        end: new Date(query.endTime).toISOString(),
      });
      const candles = z.array(candle).safeParse(body);
      if (!candles.success) {
        throw new Error(`Coinbase sent candles in an unexpected shape:\n${z.prettifyError(candles.error)}`);
      }
      return candles.data.sort((a, b) => a.time - b.time);
    },

    /** Waits until a second has passed since the last chunk. Call it before each set of requests sent together. */
    async waitForRate() {
      const waitMs = lastChunkAt + SECOND_MS - clock.now();
      if (waitMs > 0) await clock.sleep(waitMs);
      lastChunkAt = clock.now();
    },
  };
}
