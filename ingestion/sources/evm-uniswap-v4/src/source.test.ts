import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { RawRecord } from "@ingestion/lib";
import { contractFactorySqliteStore } from "@subsquid/pipes/evm";
import { mockPortal } from "@subsquid/pipes/testing";
import { encodeEvent, mockBlock } from "@subsquid/pipes/testing/evm";
import type { Abi, Hex } from "viem";
import poolManagerAbi from "../../../../catalog/protocols/uniswap/abis/v4-pool-manager.json" with { type: "json" };
import addresses from "../chains/ethereum/addresses.json" with { type: "json" };
import { forChain, type PoolManagerSourceEnv } from "#src/source.ts";

const poolManager = "0x000000000004444c5dc75cb358380d2e3de08a90";
const lookalike = "0x00000000000000000000000000000000000000cc";
const source = forChain("ethereum");
const token = addresses.tokens[0]!.toLowerCase() as Hex;
const address = (n: string) => `0x${n.padStart(40, "0")}` as Hex;
const poolId = (n: string) => `0x${n.padStart(64, "0")}` as Hex;
const [eth, high, other, hook] = [address("0"), address("ffff"), address("bb"), address("dd")];
const [early, late, stranger] = [poolId("a1"), poolId("a2"), poolId("a3")];

const initialize = (id: Hex, currency0: Hex, currency1: Hex) =>
  encodeEvent({
    abi: poolManagerAbi as Abi,
    eventName: "Initialize",
    address: poolManager,
    args: { id, currency0, currency1, fee: 3000, tickSpacing: 60, hooks: hook, sqrtPriceX96: 1n, tick: 0 },
  } as Parameters<typeof encodeEvent>[0]);
const swap = (id: Hex, amount1: bigint, emitter: Hex = poolManager) =>
  encodeEvent({
    abi: poolManagerAbi as Abi,
    eventName: "Swap",
    address: emitter,
    args: { id, sender: other, amount0: -(2n ** 100n), amount1, sqrtPriceX96: 1n, liquidity: 1n, tick: -1, fee: 3499 },
  } as Parameters<typeof encodeEvent>[0]);

// `early` holds the token as currency1 against native ETH and is created before START_BLOCK 103; `late`
// holds it as currency0 and is created after. `stranger` trades two other tokens. A contract other than
// the PoolManager emits the same Swap for `early`.
const blocks = [
  { number: 101, logs: [initialize(early, eth, token), initialize(stranger, eth, other)] },
  { number: 102, logs: [swap(early, 1n)] },
  { number: 103, logs: [swap(early, 2n), swap(stranger, 3n), swap(early, 4n, lookalike)] },
  { number: 104, logs: [initialize(late, token, high)] },
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

const env = (url: string, overrides: Partial<PoolManagerSourceEnv>): PoolManagerSourceEnv => ({
  PORTAL_URL: url,
  POOLS_START_BLOCK: 101,
  START_BLOCK: 103,
  FACTORY_DB: join(mkdtempSync(join(tmpdir(), "uniswap-v4-")), "factory.sqlite"),
  ...overrides,
});

async function records(env: PoolManagerSourceEnv) {
  const stream = await source.stream(env);
  const read: RawRecord[] = [];
  for await (const { data } of stream) read.push(...(Array.isArray(data) ? data : Object.values(data).flat()));
  return read.map(({ id, data }) => ({ id, ...(data as Loaded) }));
}

test("the token's Initializes from POOLS_START_BLOCK, and its pools' Swaps from START_BLOCK, become records", async (t) => {
  const read = await records(env(await portal(t), {}));
  assert.deepEqual(
    read.filter((r) => r.kind === "log").map((r) => `${r.block_number} ${r.event} ${r.args.id}`).sort(),
    [`101 Initialize ${early}`, `103 Swap ${early}`, `104 Initialize ${late}`, `105 Swap ${late}`],
    "no Swap before START_BLOCK, none of the stranger's pool, none from a contract other than the PoolManager",
  );
});

test("a log record is the log as emitted, keyed by its place in the chain, with its transaction's hash", async (t) => {
  const read = await records(env(await portal(t), {}));
  const { id, contract, args, ...log } = read.find((r) => r.event === "Swap" && r.block_number === 103)!;
  assert.equal(id, "103:0");
  assert.match(log.tx_hash, /^0x[0-9a-f]{64}$/);
  assert.equal("from" in log, false, "a log never carries its transaction's fields");
  assert.equal(contract, poolManager);
  assert.deepEqual(
    { amount0: args.amount0, amount1: args.amount1, fee: args.fee },
    { amount0: -(2n ** 100n), amount1: 2n, fee: 3499 },
    "signed amounts stay as the PoolManager emitted them, past what a JSON number holds",
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

test("a later run follows the pools an earlier run found, from the store", async (t) => {
  const url = await portal(t);
  const first = env(url, { START_BLOCK: 102, END_BLOCK: 102 });
  await records(first);

  const resumed = await records({ ...first, POOLS_START_BLOCK: 103, START_BLOCK: 103, END_BLOCK: undefined });
  assert.ok(
    resumed.some((r) => r.event === "Swap" && r.args.id === early),
    "the Swaps of a pool created before this run started still load",
  );
});

test("a later run follows only the stored pools of the tokens in addresses.json", async (t) => {
  const later = env(await portal(t), { POOLS_START_BLOCK: 103 });
  const store = await contractFactorySqliteStore({ path: later.FACTORY_DB });
  await store.migrate();
  await store.save([
    { childAddress: stranger, factoryAddress: poolManager, blockNumber: 101, transactionIndex: 0, logIndex: 1, event: { id: stranger, currency0: eth, currency1: other } },
  ]);

  const read = await records(later);
  assert.equal(
    read.some((r) => r.kind === "log" && r.args.id === stranger),
    false,
    "a pool left in the store from a token no longer listed is not followed",
  );
});

test("every run that resumes after a cursor with a new store fails instead of missing pools", async (t) => {
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

test("each chain loads into a table of its own, with its own store, and needs its pool manager", () => {
  assert.equal(source.name, "ethereum", "runSource writes to raw.ethereum_uniswap_v4");
  assert.equal(source.table, "uniswap_v4");
  const parsed = source.env.parse({ PORTAL_URL: "http://127.0.0.1:1", START_BLOCK: "26093738" });
  assert.equal(parsed.POOLS_START_BLOCK, 21688329, "unset, pool creations start at the pool manager's deploy block");
  assert.equal(parsed.FACTORY_DB, "chains/ethereum/factory.sqlite");
  assert.throws(() => forChain("base"), /No Uniswap v4 pool manager on base/);
});
