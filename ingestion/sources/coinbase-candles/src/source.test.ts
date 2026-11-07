import assert from "node:assert/strict";
import { cp, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Batch } from "@ingestion/lib";
import type { Clock } from "#src/coinbase.ts";
import type { CandleCall } from "#src/candles.ts";
import { coinbaseCandles, type CoinbaseEnv } from "#src/source.ts";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const HOUR = 3_600_000;
const WINDOW = 300 * HOUR;
const START = Date.UTC(2026, 0, 1);
// Five hours after START: Coinbase sends no candle for an hour with no trades.
const LISTED = START + 5 * HOUR;

/** `count` hourly candles from `first`, as Coinbase sends them: [time in seconds, low, high, open, close, volume]. */
const hourly = (first: number, count: number) =>
  Array.from({ length: count }, (_, i) => [(first + i * HOUR) / 1000, i + 0.3, i + 0.2, i + 0.1, i + 0.4, i + 0.5]);

type Reply = { status: number; body: unknown };

const online = (id: string) => ({
  id,
  base_currency: id.split("-")[0],
  quote_currency: id.split("-")[1],
  status: "online",
  trading_disabled: false,
});

/**
 * Coinbase's products and candles endpoints over `markets`, each product's candles in any order,
 * sent newest first. An unknown product gets Coinbase's 404, and `reply` may answer a request in
 * its place. `requests` gets `<product> <start>-<end>` of each candles request and `<product>` of
 * each product request, both times in epoch milliseconds.
 */
async function fakeCoinbase(
  t: TestContext,
  {
    markets,
    reply,
    requests = [],
  }: {
    markets: Record<string, unknown[][]>;
    reply?: (path: string, query: URLSearchParams) => Reply | undefined;
    requests?: string[];
  },
) {
  const server = createServer((req, res) => {
    const { pathname, searchParams: query } = new URL(req.url!, "http://coinbase");
    const [, , productId, resource] = pathname.split("/");
    const candles = markets[productId!];
    let answer: Reply;
    if (resource === "candles") {
      const start = Date.parse(query.get("start")!);
      const end = Date.parse(query.get("end")!);
      requests.push(`${productId} ${start}-${end}`);
      answer = reply?.(pathname, query) ??
        (candles
          ? {
              status: 200,
              body: candles
                .filter(([time]) => (time as number) * 1000 >= start && (time as number) * 1000 <= end)
                .sort(([a], [b]) => (b as number) - (a as number)),
            }
          : { status: 404, body: { message: "NotFound" } });
    } else {
      requests.push(productId!);
      answer = reply?.(pathname, query) ??
        (candles ? { status: 200, body: online(productId!) } : { status: 404, body: { message: "NotFound" } });
    }
    const { status, body } = answer;
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
  const dir = await mkdtemp(join(tmpdir(), "coinbase-candles-"));
  t.after(() => rm(dir, { recursive: true }));
  await cp(join(packageDir, "src"), join(dir, "src"), { recursive: true });
  await cp(join(packageDir, "package.json"), join(dir, "package.json"));
  await symlink(join(packageDir, "node_modules"), join(dir, "node_modules"));
  await writeFile(join(dir, "tokens.json"), typeof tokens === "string" ? tokens : JSON.stringify(tokens));
  const copy: typeof import("#src/source.ts") = await import(pathToFileURL(join(dir, "src", "source.ts")).href);
  return copy.candlesSource(clock);
}

const envAt = (url: string, concurrency = 2): CoinbaseEnv => ({
  COINBASE_API_URL: url,
  CANDLE_INTERVAL: "1h",
  START_TIME: START,
  COINBASE_MAX_CONCURRENCY: concurrency,
});

async function run(source: Awaited<ReturnType<typeof sourceWith>>, env: CoinbaseEnv, retry: CandleCall[] = []) {
  const batches: Batch<CandleCall>[] = [];
  for await (const batch of source.extract(env, retry)) batches.push(batch);
  return batches;
}

const window = (productId: string, base: string, start: number): CandleCall => ({
  kind: "candles",
  product_id: productId,
  base_asset: base,
  quote_asset: "USD",
  interval: "1h",
  start_time: start,
  end_time: start + WINDOW - 1,
});

const uniTokens = { quote: "USD", tokens: ["UNI"] };

test("malformed tokens.json fails the run, not the import", async (t) => {
  const source = await sourceWith(t, '{ "quote": "USD", }');
  await assert.rejects(run(source, envAt("http://127.0.0.1:1")), /tokens\.json/);
});

test("a bad entry in tokens.json fails the run, naming the entry", async (t) => {
  for (const [tokens, entry] of [
    [{ quote: "USD", tokens: ["UNI", "btc-x"] }, '"btc-x" is not a Coinbase asset'],
    [{ quote: "usd", tokens: ["UNI"] }, '"usd" is not a Coinbase asset'],
    [{ quote: "USD", tokens: [] }, "List at least one token"],
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
  const url = await fakeCoinbase(t, { markets: { "UNI-USD": hourly(LISTED, 3) }, requests });
  const source = await sourceWith(t, { quote: "USD", tokens: ["UNI", "UNI"] }, fakeClock(LISTED + 5 * HOUR));

  await run(source, envAt(url));

  assert.deepEqual(requests, ["UNI-USD", `UNI-USD ${START}-${START + WINDOW - 1}`]);
});

test("a token Coinbase does not list fails the run, naming it", async (t) => {
  const url = await fakeCoinbase(t, { markets: { "UNI-USD": hourly(LISTED, 3) } });
  const source = await sourceWith(t, { quote: "USD", tokens: ["UNI", "NOPE"] });
  await assert.rejects(run(source, envAt(url)), {
    message: "Coinbase has no market NOPE-USD for token NOPE against USD. Fix tokens.json.",
  });
});

test("loads every closed candle from START_TIME to now, 300 a call, oldest first", async (t) => {
  const url = await fakeCoinbase(t, { markets: { "UNI-USD": hourly(LISTED, 800) } });
  // Candle 700 opened 30 minutes ago and is still open.
  const source = await sourceWith(t, uniTokens, fakeClock(LISTED + 700 * HOUR + HOUR / 2));

  const batches = await run(source, envAt(url));

  const records = batches.flatMap((batch) => batch.records);
  const closed = Array.from({ length: 700 }, (_, i) => LISTED + i * HOUR);
  assert.deepEqual(
    records.map(({ id }) => id),
    closed.map((open) => `UNI-USD:1h:${open}`),
  );
  assert.ok(!records.some(({ id }) => id === `UNI-USD:1h:${LISTED + 700 * HOUR}`));
  assert.deepEqual(
    records.map(({ callId }) => callId),
    closed.map((open) => `UNI-USD:1h:${START + Math.floor((open - START) / WINDOW) * WINDOW}`),
  );
  assert.deepEqual(records[456], {
    id: `UNI-USD:1h:${LISTED + 456 * HOUR}`,
    callId: `UNI-USD:1h:${START + WINDOW}`,
    data: {
      product_id: "UNI-USD",
      base_asset: "UNI",
      quote_asset: "USD",
      interval: "1h",
      open_time: LISTED + 456 * HOUR,
      close_time: LISTED + 457 * HOUR - 1,
      open: 456.1,
      high: 456.2,
      low: 456.3,
      close: 456.4,
      volume: 456.5,
    },
  });
  // Three windows, two a chunk.
  assert.deepEqual(
    batches.map((batch) => batch.failed),
    [[], []],
  );
});

test("a successful window with no closed candles reports its call id", async (t) => {
  const url = await fakeCoinbase(t, { markets: { "UNI-USD": [] } });
  const source = await sourceWith(t, uniTokens);

  const batches = await run(source, envAt(url));

  assert.deepEqual(batches, [
    {
      records: [],
      failed: [],
      succeededCallIds: [`UNI-USD:1h:${START}`],
    },
  ]);
});

test("START_TIME inside a candle starts the windows at that candle, so each request stays within 300", async (t) => {
  const requests: string[] = [];
  const url = await fakeCoinbase(t, { markets: { "UNI-USD": hourly(START, 5) }, requests });
  const source = await sourceWith(t, uniTokens, fakeClock(START + 4 * HOUR + HOUR / 2));

  const batches = await run(source, envAt(url));

  assert.deepEqual(requests, ["UNI-USD", `UNI-USD ${START}-${START + WINDOW - 1}`]);
  assert.equal(batches.flatMap((batch) => batch.records).length, 4);
  // START_TIME is 20 minutes into the first candle, which loads too.
  const late = await sourceWith(t, uniTokens, fakeClock(START + 4 * HOUR + HOUR / 2));
  requests.length = 0;
  await run(late, { ...envAt(url), START_TIME: START + 20 * 60_000 });
  assert.deepEqual(requests, ["UNI-USD", `UNI-USD ${START}-${START + WINDOW - 1}`]);
});

test("a window whose request fails waits for the next run, and the others load", async (t) => {
  const url = await fakeCoinbase(t, {
    markets: { "UNI-USD": hourly(LISTED, 800) },
    reply: (path, query) => {
      if (!path.endsWith("/candles")) return undefined;
      const start = Date.parse(query.get("start")!);
      if (start === START + WINDOW) return { status: 500, body: { message: "Internal server error" } };
      if (start === START + 2 * WINDOW) return { status: 502, body: "Bad Gateway" };
      return undefined;
    },
  });
  const source = await sourceWith(t, uniTokens, fakeClock(LISTED + 700 * HOUR + HOUR / 2));

  const batches = await run(source, envAt(url));

  assert.deepEqual(
    batches.flatMap((batch) => batch.records.map(({ id }) => id)),
    Array.from({ length: 295 }, (_, i) => `UNI-USD:1h:${LISTED + i * HOUR}`),
  );
  assert.deepEqual(
    batches.flatMap((batch) => batch.failed),
    [
      {
        id: `UNI-USD:1h:${START + WINDOW}`,
        call: window("UNI-USD", "UNI", START + WINDOW),
        error: "Coinbase answered HTTP 500: Internal server error",
      },
      {
        id: `UNI-USD:1h:${START + 2 * WINDOW}`,
        call: window("UNI-USD", "UNI", START + 2 * WINDOW),
        error: "Coinbase answered HTTP 502: Bad Gateway",
      },
    ],
  );
});

test("a rate-limited request waits and tries again, twice, before its window fails", async (t) => {
  const limited = { status: 429, body: { message: "Public rate limit exceeded" } };
  // The first sleep is the second's wait between the market check and the window.
  for (const [answers, expected] of [
    [2, { records: 9, failed: 0, events: ["sleep 1000", "sleep 1000", "sleep 2000"] }],
    [3, { records: 0, failed: 1, events: ["sleep 1000", "sleep 1000", "sleep 2000"] }],
  ] as const) {
    let sent = 0;
    const url = await fakeCoinbase(t, {
      markets: { "UNI-USD": hourly(LISTED, 10) },
      reply: (path) => (path.endsWith("/candles") && sent++ < answers ? limited : undefined),
    });
    const events: string[] = [];
    const source = await sourceWith(t, uniTokens, fakeClock(LISTED + 9 * HOUR + HOUR / 2, events));

    const batches = await run(source, envAt(url));

    const failed = batches.flatMap((batch) => batch.failed);
    assert.equal(batches.flatMap((batch) => batch.records).length, expected.records, `${answers} answers`);
    assert.equal(failed.length, expected.failed, `${answers} answers`);
    if (failed.length > 0) assert.equal(failed[0]!.error, "Coinbase answered HTTP 429: Public rate limit exceeded");
    assert.deepEqual(events, expected.events, `${answers} answers`);
  }
});

test("a market check that fails leaves the market's windows running, and a halted market only warns", async (t) => {
  const url = await fakeCoinbase(t, {
    markets: { "UNI-USD": hourly(LISTED, 10), "BTC-USD": hourly(LISTED, 10) },
    reply: (path) => {
      if (path === "/products/UNI-USD") return { status: 500, body: { message: "Internal server error" } };
      if (path === "/products/BTC-USD") return { status: 200, body: { ...online("BTC-USD"), status: "delisted" } };
      return undefined;
    },
  });
  const source = await sourceWith(t, { quote: "USD", tokens: ["UNI", "BTC"] }, fakeClock(LISTED + 9 * HOUR + HOUR / 2));

  const batches = await run(source, envAt(url));

  const records = batches.flatMap((batch) => batch.records);
  for (const productId of ["UNI-USD", "BTC-USD"]) {
    assert.deepEqual(
      records.filter(({ id }) => id.startsWith(productId)).map(({ id }) => id),
      Array.from({ length: 9 }, (_, i) => `${productId}:1h:${LISTED + i * HOUR}`),
    );
  }
  assert.deepEqual(batches.flatMap((batch) => batch.failed), []);
});

test("a candle that closes while Coinbase's reply is on its way is left for the next run", async (t) => {
  // Candle 9 is open when the window is requested and has closed by the time the reply arrives.
  let now = LISTED + 9 * HOUR + HOUR / 2;
  const clock: Clock = { now: () => now, sleep: async (ms) => void (now += ms) };
  const url = await fakeCoinbase(t, {
    markets: { "UNI-USD": hourly(LISTED, 10) },
    reply: (path) => {
      if (path.endsWith("/candles")) now = LISTED + 10 * HOUR + 60_000;
      return undefined;
    },
  });
  const source = await sourceWith(t, uniTokens, clock);

  const batches = await run(source, envAt(url));

  assert.deepEqual(
    batches.flatMap((batch) => batch.records.map(({ id }) => id)),
    Array.from({ length: 9 }, (_, i) => `UNI-USD:1h:${LISTED + i * HOUR}`),
  );
});

test("a candle Coinbase sends from outside the window is dropped", async (t) => {
  // Coinbase answers the first window with the candle that opens the next one too.
  const url = await fakeCoinbase(t, {
    markets: { "UNI-USD": hourly(START, 10) },
    reply: (path, query) =>
      path.endsWith("/candles") && Date.parse(query.get("start")!) === START
        ? { status: 200, body: [...hourly(START, 10), ...hourly(START + WINDOW, 1)] }
        : undefined,
  });
  const source = await sourceWith(t, uniTokens, fakeClock(START + WINDOW + HOUR + HOUR / 2));

  const batches = await run(source, envAt(url));

  // Both windows go in one chunk, and the second has no candles of its own.
  assert.deepEqual(
    batches.map((batch) => batch.records.map(({ id }) => id)),
    [Array.from({ length: 10 }, (_, i) => `UNI-USD:1h:${START + i * HOUR}`)],
  );
});

test("retried calls are made again, and a new call replaces its retried twin", async (t) => {
  const requests: string[] = [];
  const btcListed = START - 30 * HOUR;
  const url = await fakeCoinbase(t, {
    markets: { "UNI-USD": hourly(LISTED, 10), "BTC-USD": hourly(btcListed, 20) },
    requests,
  });
  const source = await sourceWith(t, uniTokens, fakeClock(LISTED + 9 * HOUR + HOUR / 2));
  // BTC has left tokens.json since its window failed.
  const btc = window("BTC-USD", "BTC", btcListed + 10 * HOUR);
  const staleUni = { ...window("UNI-USD", "UNI", START), end_time: START + HOUR - 1 };

  const batches = await run(source, envAt(url), [btc, staleUni]);

  const records = batches.flatMap((batch) => batch.records);
  assert.deepEqual(
    records.filter(({ id }) => id.startsWith("BTC-USD")).map(({ id, callId }) => ({ id, callId })),
    Array.from({ length: 10 }, (_, i) => ({
      id: `BTC-USD:1h:${btcListed + (10 + i) * HOUR}`,
      callId: `BTC-USD:1h:${btcListed + 10 * HOUR}`,
    })),
  );
  assert.deepEqual(
    requests.filter((request) => request.startsWith(`UNI-USD ${START}-`)),
    [`UNI-USD ${START}-${START + WINDOW - 1}`],
  );
  assert.equal(records.filter(({ id }) => id.startsWith("UNI-USD")).length, 9);
});

test("sends one chunk of requests a second", async (t) => {
  const events: string[] = [];
  const url = await fakeCoinbase(t, {
    markets: { "UNI-USD": hourly(LISTED, 10), "BTC-USD": hourly(LISTED, 10), "ETH-USD": hourly(LISTED, 10) },
    requests: events,
  });
  // The checks take two chunks, the windows two more, and the second chunk of each waits for the next second.
  const source = await sourceWith(t, { quote: "USD", tokens: ["UNI", "BTC", "ETH"] }, fakeClock(LISTED + 5 * HOUR, events));

  await run(source, envAt(url));

  // Two checks, a wait, the third check, a wait, two windows, a wait, the third window.
  assert.deepEqual(
    events.map((event) => (event.startsWith("sleep") ? event : "request")),
    ["request", "request", "sleep 1000", "request", "sleep 1000", "request", "request", "sleep 1000", "request"],
  );
});

test("START_TIME takes an ISO date or datetime, and the rest have defaults", () => {
  const midnight = Date.UTC(2026, 9, 1);
  assert.deepEqual(coinbaseCandles.env.parse({ START_TIME: "2026-10-01" }), {
    COINBASE_API_URL: "https://api.exchange.coinbase.com",
    CANDLE_INTERVAL: "1h",
    START_TIME: midnight,
    COINBASE_MAX_CONCURRENCY: 5,
  });
  assert.equal(coinbaseCandles.env.parse({ START_TIME: "2026-10-01T00:00:00Z" }).START_TIME, midnight);
  assert.equal(coinbaseCandles.env.parse({ START_TIME: "2026-10-01T02:00:00+02:00" }).START_TIME, midnight);
  assert.throws(() => coinbaseCandles.env.parse({ START_TIME: "yesterday" }), /ISO date or datetime/);
  // Binance's 3m, 2h, 4h, 8h, 12h, 3d and 1w are not Coinbase granularities.
  assert.throws(() => coinbaseCandles.env.parse({ START_TIME: "2026-10-01", CANDLE_INTERVAL: "4h" }));
});

test("COINBASE_MAX_CONCURRENCY is at most 10, Coinbase's public requests a second", () => {
  const parse = (concurrency: string) =>
    coinbaseCandles.env.parse({ START_TIME: "2026-10-01", COINBASE_MAX_CONCURRENCY: concurrency });
  assert.equal(parse("10").COINBASE_MAX_CONCURRENCY, 10);
  assert.throws(() => parse("11"));
});
