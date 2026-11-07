import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { RawRecord } from "@ingestion/lib";
import { mockPortal } from "@subsquid/pipes/testing";
import { encodeEvent, mockBlock } from "@subsquid/pipes/testing/evm";
import type { Abi, Hex } from "viem";
import factoryAbi from "../../../../catalog/protocols/uniswap/abis/v2-factory.json" with { type: "json" };
import pairAbi from "../../../../catalog/protocols/uniswap/abis/v2-pair.json" with { type: "json" };
import addresses from "../chains/ethereum/addresses.json" with { type: "json" };
import { forChain, type FactorySourceEnv } from "#src/source.ts";

const factory = "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f";
const source = forChain("ethereum");
const token = addresses.tokens[0]!.toLowerCase() as Hex;
const address = (n: string) => `0x${n.padStart(40, "0")}` as Hex;
const [low, high, other] = [address("11"), address("ffff"), address("bb")];
const [early, late, stranger, fork] = [address("a1"), address("a2"), address("a3"), address("a4")];

const created = (token0: Hex, token1: Hex, pair: Hex) =>
  encodeEvent({
    abi: factoryAbi as Abi,
    eventName: "PairCreated",
    address: factory,
    args: { token0, token1, pair, "": 1n },
  } as Parameters<typeof encodeEvent>[0]);
const swap = (pair: Hex, amount0In: bigint) =>
  encodeEvent({
    abi: pairAbi as Abi,
    eventName: "Swap",
    address: pair,
    args: { sender: other, amount0In, amount1In: 0n, amount0Out: 0n, amount1Out: 2n ** 100n, to: other },
  } as Parameters<typeof encodeEvent>[0]);

// `early` holds the token as token1 and is created before START_BLOCK 103; `late` holds it as token0 and
// is created after. `stranger` trades two other tokens. `fork` is no factory's pair but emits the same Swap.
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
  FACTORY_DB: join(mkdtempSync(join(tmpdir(), "uniswap-v2-")), "factory.sqlite"),
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
    [`101 PairCreated ${factory}`, `103 Swap ${early}`, `104 PairCreated ${factory}`, `105 Swap ${late}`],
    "no Swap before START_BLOCK, none of the stranger's pair, none of the fork",
  );
});

test("a log record is the log as emitted, keyed by its place in the chain, with its transaction's hash", async (t) => {
  const read = await records(env(await portal(t), {}));
  const { id, args, ...log } = read.find((r) => r.event === "Swap" && r.block_number === 103)!;
  assert.equal(id, "103:0");
  assert.match(log.tx_hash, /^0x[0-9a-f]{64}$/);
  assert.equal("from" in log, false, "a log never carries its transaction's fields");
  assert.deepEqual(
    { amount0In: args.amount0In, amount1Out: args.amount1Out },
    { amount0In: 2n, amount1Out: 2n ** 100n },
    "amounts stay as the pair emitted them, past what a JSON number holds",
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
    "the Swaps of a pair created before this run started still load",
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
  assert.equal(source.name, "ethereum", "runSource writes to raw.ethereum_uniswap_v2");
  assert.equal(source.table, "uniswap_v2");
  const parsed = source.env.parse({ PORTAL_URL: "http://127.0.0.1:1", START_BLOCK: "26093738" });
  assert.equal(parsed.POOLS_START_BLOCK, 10000835, "unset, pool creations start at the factory's deploy block");
  assert.equal(parsed.FACTORY_DB, "chains/ethereum/factory.sqlite");
  assert.throws(() => forChain("base"), /No Uniswap v2 factory on base/);
});
