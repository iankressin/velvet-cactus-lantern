import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { RawRecord } from "@ingestion/lib";
import { mockPortal } from "@subsquid/pipes/testing";
import { encodeEvent, mockBlock } from "@subsquid/pipes/testing/evm";
import type { Abi, Hex } from "viem";
import factoryAbi from "../../../../catalog/protocols/uniswap/abis/v3-factory.json" with { type: "json" };
import poolAbi from "../../../../catalog/protocols/uniswap/abis/v3-pool.json" with { type: "json" };
import addresses from "../chains/ethereum/addresses.json" with { type: "json" };
import { forChain, type FactorySourceEnv } from "#src/source.ts";

const factory = "0x1f98431c8ad98523631ae4a59f267346ea31f984";
const source = forChain("ethereum");
const token = addresses.tokens[0]!.toLowerCase() as Hex;
const address = (n: string) => `0x${n.padStart(40, "0")}` as Hex;
const [low, high, other] = [address("11"), address("ffff"), address("bb")];
const [early, late, stranger, fork] = [address("a1"), address("a2"), address("a3"), address("a4")];

const created = (token0: Hex, token1: Hex, pool: Hex) =>
  encodeEvent({
    abi: factoryAbi as Abi,
    eventName: "PoolCreated",
    address: factory,
    args: { token0, token1, fee: 3000, tickSpacing: 60, pool },
  } as Parameters<typeof encodeEvent>[0]);
const swap = (pool: Hex, amount0: bigint) =>
  encodeEvent({
    abi: poolAbi as Abi,
    eventName: "Swap",
    address: pool,
    args: { sender: other, recipient: other, amount0, amount1: -(2n ** 100n), sqrtPriceX96: 1n, liquidity: 1n, tick: -1 },
  } as Parameters<typeof encodeEvent>[0]);

// `early` holds the token as token1 and is created before START_BLOCK 103; `late` holds it as token0 and
// is created after. `stranger` trades two other tokens. `fork` is no factory's pool but emits the same Swap.
const blocks = [
  { number: 101, logs: [created(low, token, early), created(low, other, stranger)] },
  { number: 102, logs: [swap(early, 1n)] },
  { number: 103, logs: [swap(early, 2n), swap(stranger, 3n), swap(fork, 4n)] },
  { number: 104, logs: [created(token, high, late)] },
  { number: 105, logs: [swap(late, 5n)] },
].map(({ number, logs }) =>
  mockBlock({ number, transactions: logs.map((log, i) => ({ from: address(`f${number}${i}`), logs: [log] })) }),
);

async function portal(t: TestContext) {
  const mock = await mockPortal({ blocks });
  t.after(() => mock.close());
  return mock.url;
}

type Loaded = {
  kind: string;
  event: string;
  block_number: number;
  contract: string;
  tx_hash: string;
  args: Record<string, unknown>;
  hash: string;
  from: string;
};

const env = (url: string, overrides: Partial<FactorySourceEnv>): FactorySourceEnv => ({
  PORTAL_URL: url,
  POOLS_START_BLOCK: 101,
  START_BLOCK: 103,
  FACTORY_DB: join(mkdtempSync(join(tmpdir(), "uniswap-v3-")), "factory.sqlite"),
  ...overrides,
});

async function records(env: FactorySourceEnv) {
  const stream = await source.stream(env);
  const read: RawRecord[] = [];
  for await (const { data } of stream) read.push(...(Array.isArray(data) ? data : Object.values(data).flat()));
  return read.map(({ id, data }) => ({ id, ...(data as Loaded) }));
}

test("the token's pool creations from POOLS_START_BLOCK, and its pools' Swaps from START_BLOCK, become records", async (t) => {
  const read = await records(env(await portal(t), {}));
  assert.deepEqual(
    read.filter((r) => r.kind === "log").map((r) => `${r.block_number} ${r.event} ${r.contract}`).sort(),
    [`101 PoolCreated ${factory}`, `103 Swap ${early}`, `104 PoolCreated ${factory}`, `105 Swap ${late}`],
    "no Swap before START_BLOCK, none of the stranger's pool, none of the fork",
  );
});

test("a log record is the log as emitted, keyed by its place in the chain, with its transaction's hash", async (t) => {
  const read = await records(env(await portal(t), {}));
  const { id, args, ...log } = read.find((r) => r.event === "Swap" && r.block_number === 103)!;
  assert.equal(id, "103:0");
  assert.match(log.tx_hash, /^0x[0-9a-f]{64}$/);
  assert.equal("from" in log, false, "a log never carries its transaction's fields");
  assert.deepEqual(
    { amount0: args.amount0, amount1: args.amount1 },
    { amount0: 2n, amount1: -(2n ** 100n) },
    "signed amounts stay as the pool emitted them, past what a JSON number holds",
  );
});

test("each written log's transaction becomes a record of its own, and no other transaction does", async (t) => {
  const read = await records(env(await portal(t), {}));
  const logs = read.filter((r) => r.kind === "log");
  assert.deepEqual(
    read.filter((r) => r.kind === "transaction").map((r) => r.id).sort(),
    [...new Set(logs.map((r) => `tx:${r.tx_hash}`))].sort(),
    "none for the transactions of the Swaps the source dropped",
  );
  const swap = logs.find((r) => r.event === "Swap" && r.block_number === 103)!;
  assert.deepEqual(read.find((r) => r.id === `tx:${swap.tx_hash}`), {
    id: `tx:${swap.tx_hash}`,
    kind: "transaction",
    block_number: 103,
    hash: swap.tx_hash,
    from: address("f1030"),
  });
});

test("a later run follows the pools an earlier run found, from the factory store", async (t) => {
  const url = await portal(t);
  const first = env(url, { START_BLOCK: 102, END_BLOCK: 102 });
  await records(first);

  const resumed = await records({ ...first, POOLS_START_BLOCK: 103, START_BLOCK: 103, END_BLOCK: undefined });
  assert.ok(
    resumed.some((r) => r.event === "Swap" && r.contract === early),
    "the Swaps of a pool created before this run started still load",
  );
});

test("every run that resumes after a cursor with a new factory store fails instead of missing pools", async (t) => {
  const url = await portal(t);
  const lost = env(url, {});
  for (const attempt of [1, 2]) {
    const stream = await source.stream(lost);
    await assert.rejects(
      stream.pipeTo({
        write: async ({ read }) => {
          for await (const _ of read({ latest: { number: 102 }, finalized: null }));
        },
      }),
      /factory\.sqlite is new, but the cursor is at block 102/,
      `attempt ${attempt}`,
    );
  }
  assert.equal(existsSync(lost.FACTORY_DB), false, "a refused run leaves no store behind");
});

test("POOLS_START_BLOCK after START_BLOCK is refused", () => {
  const parsed = source.env.safeParse({ PORTAL_URL: "http://127.0.0.1:1", START_BLOCK: "103", POOLS_START_BLOCK: "104" });
  assert.equal(parsed.success, false);
  assert.match(parsed.error!.message, /POOLS_START_BLOCK must not be after START_BLOCK/);
});

test("each chain loads into a table of its own, with its own store, and needs its factory", () => {
  assert.equal(source.name, "ethereum", "runSource writes to raw.ethereum_uniswap_v3");
  assert.equal(source.table, "uniswap_v3");
  const parsed = source.env.parse({ PORTAL_URL: "http://127.0.0.1:1", START_BLOCK: "26093738" });
  assert.equal(parsed.POOLS_START_BLOCK, 12369621, "unset, pool creations start at the factory's deploy block");
  assert.equal(parsed.FACTORY_DB, "chains/ethereum/factory.sqlite");
  assert.throws(() => forChain("base"), /No Uniswap v3 factory on base/);
});
