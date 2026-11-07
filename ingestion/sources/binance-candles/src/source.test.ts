import assert from "node:assert/strict";
import { cp, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Batch } from "@ingestion/lib";
import type { Clock } from "#src/binance.ts";
import type { CandleCall } from "#src/candles.ts";
import { binanceCandles, type BinanceEnv } from "#src/source.ts";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const HOUR = 3_600_000;
const START = Date.UTC(2026, 0, 1);
// Five hours after START, so the probe finds where trading starts.
const LISTED = START + 5 * HOUR;

/** `count` hourly candles from `first`, as Binance sends them, each with prices of its own. */
const hourly = (first: number, count: number) =>
  Array.from({ length: count }, (_, i) => {
    const open = first + i * HOUR;
    return [open, `${i}.1`, `${i}.2`, `${i}.3`, `${i}.4`, `${i}.5`, open + HOUR - 1, `${i}.6`, i, `${i}.7`, `${i}.8`, "0"];
  });

type Reply = { status: number; body: unknown };

/**
 * Binance's klines endpoint over `markets`, each symbol's candles oldest first. An unknown symbol
 * gets Binance's -1121, and `reply` may answer a request in its place. Every response carries
 * `weight` as the minute's used weight. `requests` gets `symbol startTime-endTime` of each request.
 */
async function fakeBinance(
  t: TestContext,
  {
    markets,
    weight = 2,
    reply,
    requests = [],
  }: {
    markets: Record<string, unknown[][]>;
    weight?: number;
    reply?: (query: URLSearchParams) => Reply | undefined;
    requests?: string[];
  },
) {
  const server = createServer((req, res) => {
    const query = new URL(req.url!, "http://binance").searchParams;
    const symbol = query.get("symbol")!;
    const start = Number(query.get("startTime"));
    const end = query.has("endTime") ? Number(query.get("endTime")) : Infinity;
    requests.push(`${symbol} ${start}-${query.get("endTime") ?? ""}`);
    const candles = markets[symbol];
    const { status, body } = reply?.(query) ??
      (candles
        ? {
            status: 200,
            body: candles
              .filter(([open]) => (open as number) >= start && (open as number) <= end)
              .slice(0, Number(query.get("limit"))),
          }
        : { status: 400, body: { code: -1121, msg: "Invalid symbol." } });
    res.setHeader("x-mbx-used-weight-1m", String(weight));
    if (typeof body === "string") {
      res.writeHead(status, { "content-type": "text/plain" }).end(body);
    } else {
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A clock stopped at `now` that a sleep moves forward at once. `events` gets each sleep. */
function fakeClock(now: number, events: string[] = []): Clock {
  return {
    now: () => now,
    sleep: async (ms) => {
      events.push(`sleep ${ms}`);
      now += ms;
    },
  };
}

/** This package's source with `clock`, imported from a copy of the package whose tokens.json holds `tokens`. */
async function sourceWith(t: TestContext, tokens: unknown, clock: Clock = fakeClock(LISTED)) {
  const dir = await mkdtemp(join(tmpdir(), "binance-candles-"));
  t.after(() => rm(dir, { recursive: true }));
  await cp(join(packageDir, "src"), join(dir, "src"), { recursive: true });
  await cp(join(packageDir, "package.json"), join(dir, "package.json"));
  await symlink(join(packageDir, "node_modules"), join(dir, "node_modules"));
  await writeFile(join(dir, "tokens.json"), typeof tokens === "string" ? tokens : JSON.stringify(tokens));
  const copy: typeof import("#src/source.ts") = await import(pathToFileURL(join(dir, "src", "source.ts")).href);
  return copy.candlesSource(clock);
}

const envAt = (url: string, concurrency = 2): BinanceEnv => ({
  BINANCE_API_URL: url,
  CANDLE_INTERVAL: "1h",
  START_TIME: START,
  BINANCE_MAX_CONCURRENCY: concurrency,
});

async function run(source: Awaited<ReturnType<typeof sourceWith>>, env: BinanceEnv, retry: CandleCall[] = []) {
  const batches: Batch<CandleCall>[] = [];
  for await (const batch of source.extract(env, retry)) batches.push(batch);
  return batches;
}

const window = (symbol: string, base: string, start: number): CandleCall => ({
  kind: "candles",
  symbol,
  base_asset: base,
  quote_asset: "USDT",
  interval: "1h",
  start_time: start,
  end_time: start + 1000 * HOUR - 1,
});

const uniTokens = { quote: "USDT", tokens: ["UNI"] };

test("malformed tokens.json fails the run, not the import", async (t) => {
  const source = await sourceWith(t, '{ "quote": "USDT", }');
  await assert.rejects(run(source, envAt("http://127.0.0.1:1")), /tokens\.json/);
});

test("a bad entry in tokens.json fails the run, naming the entry", async (t) => {
  for (const [tokens, entry] of [
    [{ quote: "USDT", tokens: ["UNI", "btc-x"] }, '"btc-x" is not a Binance asset'],
    [{ quote: "usdt", tokens: ["UNI"] }, '"usdt" is not a Binance asset'],
    [{ quote: "USDT", tokens: [] }, "List at least one token"],
  ] as const) {
    const source = await sourceWith(t, tokens);
    await assert.rejects(run(source, envAt("http://127.0.0.1:1")), (error: Error) => {
      assert.match(error.message, /^Invalid tokens\.json:/);
      assert.ok(error.message.includes(entry), error.message);
      return true;
    });
  }
});

test("a token listed twice in tokens.json is read once", async (t) => {
  const requests: string[] = [];
  const url = await fakeBinance(t, { markets: { UNIUSDT: hourly(LISTED, 3) }, requests });
  const source = await sourceWith(t, { quote: "USDT", tokens: ["UNI", "UNI"] }, fakeClock(LISTED + 5 * HOUR));

  await run(source, envAt(url));

  assert.deepEqual(requests, [`UNIUSDT ${START}-`, `UNIUSDT ${LISTED}-${LISTED + 1000 * HOUR - 1}`]);
});

test("a token Binance does not list fails the run, naming it", async (t) => {
  const url = await fakeBinance(t, { markets: { UNIUSDT: hourly(LISTED, 3) } });
  const source = await sourceWith(t, { quote: "USDT", tokens: ["UNI", "NOPE"] });
  await assert.rejects(run(source, envAt(url)), {
    message: "Binance has no market NOPEUSDT for token NOPE against USDT. Fix tokens.json.",
  });
});

test("a token with no candles since START_TIME fails the run", async (t) => {
  const url = await fakeBinance(t, { markets: { UNIUSDT: hourly(START - 10 * HOUR, 3) } });
  const source = await sourceWith(t, uniTokens);
  await assert.rejects(run(source, envAt(url)), {
    message: "Binance has no 1h candles of UNIUSDT since START_TIME (2026-01-01T00:00:00.000Z)",
  });
});

test("loads every closed candle from the listing to now, 1000 a call", async (t) => {
  const url = await fakeBinance(t, { markets: { UNIUSDT: hourly(LISTED, 2500) } });
  // Candle 2400 opened 30 minutes ago and is still open.
  const source = await sourceWith(t, uniTokens, fakeClock(LISTED + 2400 * HOUR + HOUR / 2));

  const batches = await run(source, envAt(url));

  const records = batches.flatMap((batch) => batch.records);
  const closed = Array.from({ length: 2400 }, (_, i) => LISTED + i * HOUR);
  assert.deepEqual(
    records.map(({ id }) => id),
    closed.map((open) => `UNIUSDT:1h:${open}`),
  );
  assert.ok(!records.some(({ id }) => id === `UNIUSDT:1h:${LISTED + 2400 * HOUR}`));
  assert.deepEqual(
    records.map(({ callId }) => callId),
    closed.map((_, i) => `UNIUSDT:1h:${LISTED + Math.floor(i / 1000) * 1000 * HOUR}`),
  );
  assert.deepEqual(records[1234], {
    id: `UNIUSDT:1h:${LISTED + 1234 * HOUR}`,
    callId: `UNIUSDT:1h:${LISTED + 1000 * HOUR}`,
    data: {
      symbol: "UNIUSDT",
      base_asset: "UNI",
      quote_asset: "USDT",
      interval: "1h",
      open_time: LISTED + 1234 * HOUR,
      open: "1234.1",
      high: "1234.2",
      low: "1234.3",
      close: "1234.4",
      volume: "1234.5",
      close_time: LISTED + 1235 * HOUR - 1,
      quote_volume: "1234.6",
      trades: 1234,
      taker_buy_base_volume: "1234.7",
      taker_buy_quote_volume: "1234.8",
    },
  });
  assert.deepEqual(
    batches.map((batch) => batch.failed),
    [[], []],
  );
});

test("a window whose request fails waits for the next run, and the others load", async (t) => {
  const url = await fakeBinance(t, {
    markets: { UNIUSDT: hourly(LISTED, 2500) },
    reply: (query) => {
      const start = Number(query.get("startTime"));
      if (start === LISTED + 1000 * HOUR) {
        return { status: 500, body: { code: -1000, msg: "An unknown error occurred while processing the request." } };
      }
      if (start === LISTED + 2000 * HOUR) return { status: 502, body: "Bad Gateway" };
      return undefined;
    },
  });
  const source = await sourceWith(t, uniTokens, fakeClock(LISTED + 2400 * HOUR + HOUR / 2));

  const batches = await run(source, envAt(url));

  assert.deepEqual(
    batches.flatMap((batch) => batch.records.map(({ id }) => id)),
    Array.from({ length: 1000 }, (_, i) => `UNIUSDT:1h:${LISTED + i * HOUR}`),
  );
  assert.deepEqual(
    batches.flatMap((batch) => batch.failed),
    [
      {
        id: `UNIUSDT:1h:${LISTED + 1000 * HOUR}`,
        call: window("UNIUSDT", "UNI", LISTED + 1000 * HOUR),
        error: "Binance answered HTTP 500 with code -1000: An unknown error occurred while processing the request.",
      },
      {
        id: `UNIUSDT:1h:${LISTED + 2000 * HOUR}`,
        call: window("UNIUSDT", "UNI", LISTED + 2000 * HOUR),
        error: "Binance answered HTTP 502: Bad Gateway",
      },
    ],
  );
});

test("a ban fails the run, in the probe or in a window", async (t) => {
  for (const limit of ["1", "1000"]) {
    const url = await fakeBinance(t, {
      markets: { UNIUSDT: hourly(LISTED, 10) },
      reply: (query) =>
        query.get("limit") === limit ? { status: 418, body: { code: -1003, msg: "Way too many requests." } } : undefined,
    });
    const source = await sourceWith(t, uniTokens, fakeClock(LISTED + 5 * HOUR));

    await assert.rejects(run(source, envAt(url)), /banned this IP.*HTTP 418/, `limit ${limit}`);
  }
});

test("a probe that fails starts the market's windows at START_TIME, and the other markets load as usual", async (t) => {
  const requests: string[] = [];
  const url = await fakeBinance(t, {
    markets: { UNIUSDT: hourly(LISTED, 10), BTCUSDT: hourly(LISTED, 10) },
    reply: (query) =>
      query.get("symbol") === "UNIUSDT" && query.get("limit") === "1"
        ? { status: 500, body: { code: -1000, msg: "An unknown error occurred while processing the request." } }
        : undefined,
    requests,
  });
  const source = await sourceWith(t, { quote: "USDT", tokens: ["UNI", "BTC"] }, fakeClock(LISTED + 9 * HOUR + HOUR / 2));

  const batches = await run(source, envAt(url));

  // The two windows are requested at once, so they may arrive in either order.
  assert.deepEqual(
    requests.filter((request) => !request.endsWith("-")).sort(),
    [`BTCUSDT ${LISTED}-${LISTED + 1000 * HOUR - 1}`, `UNIUSDT ${START}-${START + 1000 * HOUR - 1}`],
  );
  const records = batches.flatMap((batch) => batch.records);
  for (const symbol of ["UNIUSDT", "BTCUSDT"]) {
    assert.deepEqual(
      records.filter(({ id }) => id.startsWith(symbol)).map(({ id }) => id),
      Array.from({ length: 9 }, (_, i) => `${symbol}:1h:${LISTED + i * HOUR}`),
    );
  }
  assert.deepEqual(batches.flatMap((batch) => batch.failed), []);
});

test("a candle that closes while Binance's reply is on its way is left for the next run", async (t) => {
  // Candle 9 is open when the window is requested and has closed by the time the reply arrives.
  let now = LISTED + 9 * HOUR + HOUR / 2;
  const clock: Clock = { now: () => now, sleep: async (ms) => void (now += ms) };
  const url = await fakeBinance(t, {
    markets: { UNIUSDT: hourly(LISTED, 10) },
    reply: (query) => {
      if (query.get("limit") === "1000") now = LISTED + 10 * HOUR + 60_000;
      return undefined;
    },
  });
  const source = await sourceWith(t, uniTokens, clock);

  const batches = await run(source, envAt(url));

  assert.deepEqual(
    batches.flatMap((batch) => batch.records.map(({ id }) => id)),
    Array.from({ length: 9 }, (_, i) => `UNIUSDT:1h:${LISTED + i * HOUR}`),
  );
});

test("retried calls are made again, and a new call replaces its retried twin", async (t) => {
  const requests: string[] = [];
  const btcListed = START - 30 * HOUR;
  const url = await fakeBinance(t, {
    markets: { UNIUSDT: hourly(LISTED, 10), BTCUSDT: hourly(btcListed, 20) },
    requests,
  });
  const source = await sourceWith(t, uniTokens, fakeClock(LISTED + 9 * HOUR + HOUR / 2));
  // BTC has left tokens.json since its window failed.
  const btc = window("BTCUSDT", "BTC", btcListed + 10 * HOUR);
  const staleUni = { ...window("UNIUSDT", "UNI", LISTED), end_time: LISTED + HOUR - 1 };

  const batches = await run(source, envAt(url), [btc, staleUni]);

  const records = batches.flatMap((batch) => batch.records);
  assert.deepEqual(
    records.filter(({ id }) => id.startsWith("BTCUSDT")).map(({ id, callId }) => ({ id, callId })),
    Array.from({ length: 10 }, (_, i) => ({
      id: `BTCUSDT:1h:${btcListed + (10 + i) * HOUR}`,
      callId: `BTCUSDT:1h:${btcListed + 10 * HOUR}`,
    })),
  );
  assert.deepEqual(
    requests.filter((request) => request.startsWith(`UNIUSDT ${LISTED}-`)),
    [`UNIUSDT ${LISTED}-${LISTED + 1000 * HOUR - 1}`],
  );
  assert.equal(records.filter(({ id }) => id.startsWith("UNIUSDT")).length, 9);
});

test("waits for the next minute before a chunk once the minute's weight reaches 5000", async (t) => {
  const probe = `UNIUSDT ${START}-`;
  const firstWindow = `UNIUSDT ${LISTED}-${LISTED + 1000 * HOUR - 1}`;
  for (const [weight, expected] of [
    [5000, [probe, "sleep 45000", firstWindow]],
    [4999, [probe, firstWindow]],
  ] as const) {
    const events: string[] = [];
    const url = await fakeBinance(t, { markets: { UNIUSDT: hourly(LISTED, 10) }, weight, requests: events });
    // 15 seconds into a minute.
    const source = await sourceWith(t, uniTokens, fakeClock(LISTED + 5 * HOUR + 15_000, events));

    await run(source, envAt(url));

    assert.deepEqual(events, expected, `weight ${weight}`);
  }
});

test("START_TIME takes an ISO date or datetime, and the rest have defaults", () => {
  const midnight = Date.UTC(2026, 9, 1);
  assert.deepEqual(binanceCandles.env.parse({ START_TIME: "2026-10-01" }), {
    BINANCE_API_URL: "https://data-api.binance.vision",
    CANDLE_INTERVAL: "1h",
    START_TIME: midnight,
    BINANCE_MAX_CONCURRENCY: 5,
  });
  assert.equal(binanceCandles.env.parse({ START_TIME: "2026-10-01T00:00:00Z" }).START_TIME, midnight);
  assert.equal(binanceCandles.env.parse({ START_TIME: "2026-10-01T02:00:00+02:00" }).START_TIME, midnight);
  assert.throws(() => binanceCandles.env.parse({ START_TIME: "yesterday" }), /ISO date or datetime/);
  assert.throws(() => binanceCandles.env.parse({ START_TIME: "2026-10-01", CANDLE_INTERVAL: "1M" }));
});

test("BINANCE_MAX_CONCURRENCY is at most 100, so a chunk fits in the weight left under the budget", () => {
  const parse = (concurrency: string) =>
    binanceCandles.env.parse({ START_TIME: "2026-10-01", BINANCE_MAX_CONCURRENCY: concurrency });
  assert.equal(parse("100").BINANCE_MAX_CONCURRENCY, 100);
  assert.throws(() => parse("101"));
});
