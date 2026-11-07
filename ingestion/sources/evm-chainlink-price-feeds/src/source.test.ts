import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { RawRecord } from "@ingestion/lib";
import { mockPortal } from "@subsquid/pipes/testing";
import { encodeEvent, mockBlock } from "@subsquid/pipes/testing/evm";
import type { Abi, Hex } from "viem";
import aggregatorAbi from "../../../../catalog/protocols/chainlink/abis/aggregator.json" with { type: "json" };
import ethereum from "../chains/ethereum/addresses.json" with { type: "json" };
import { forChain, type PriceFeedsEnv } from "#src/source.ts";

const abi = aggregatorAbi as Abi;
const [ethUsd, btcUsd, uniUsd] = ethereum.aggregators as Hex[];
const unlisted = "0x00000000000000000000000000000000000000aa";

const answer = (aggregator: Hex, current: bigint, roundId: bigint, updatedAt: bigint) =>
  encodeEvent({ abi, eventName: "AnswerUpdated", address: aggregator, args: { current, roundId, updatedAt } as never });

async function portal(t: TestContext, blocks: ReturnType<typeof mockBlock>[]) {
  const mock = await mockPortal({ blocks });
  t.after(() => mock.close());
  return mock.url;
}

async function records(env: PriceFeedsEnv) {
  const stream = await forChain("ethereum").stream(env);
  const read: RawRecord[] = [];
  for await (const { data } of stream) read.push(...(Array.isArray(data) ? data : Object.values(data).flat()));
  return read;
}

test("AnswerUpdated from the listed aggregators becomes records; from another contract it does not", async (t) => {
  const blocks = [
    mockBlock({ number: 26356592, timestamp: 1793977523, transactions: [{ logs: [answer(btcUsd!, 7491944487991n, 25783n, 1793977523n)] }] }),
    mockBlock({
      number: 26356593,
      timestamp: 1793977535,
      transactions: [{ logs: [answer(unlisted, 1n, 1n, 1793977535n), answer(uniUsd!, -697007592n, 27472n, 1793977535n)] }],
    }),
    mockBlock({ number: 26356594, timestamp: 1793977547, transactions: [{ logs: [answer(ethUsd!, 220971000000n, 35420n, 1793977547n)] }] }),
  ];
  const read = await records({ PORTAL_URL: await portal(t, blocks), START_BLOCK: 26356592 });

  assert.deepEqual(
    read.map((r) => [r.id, r.data.contract]),
    [
      ["26356592:0", btcUsd],
      ["26356593:1", uniUsd],
      ["26356594:0", ethUsd],
    ],
    "26356593:0, from a contract not in addresses.json, is left out",
  );
  assert.deepEqual(read[1], {
    id: "26356593:1",
    callId: "26356593:1",
    data: {
      kind: "log",
      event: "AnswerUpdated",
      block_number: 26356593,
      timestamp: "2026-11-06T15:05:35.000Z",
      tx_hash: blocks[1]!.transactions[0]!.hash,
      log_index: 1,
      contract: uniUsd,
      args: { current: -697007592n, roundId: 27472n, updatedAt: 1793977535n },
    },
  });
});

test("the stream starts at START_BLOCK and stops at END_BLOCK", async (t) => {
  const blocks = [1, 2, 3, 4].map((number) =>
    mockBlock({ number, transactions: [{ logs: [answer(ethUsd!, 1n, BigInt(number), BigInt(number))] }] }),
  );
  const read = await records({ PORTAL_URL: await portal(t, blocks), START_BLOCK: 2, END_BLOCK: 3 });
  assert.deepEqual(read.map((r) => r.data.block_number), [2, 3]);
});

async function chdirWithAddresses(t: TestContext, json: string) {
  const dir = await mkdtemp(join(tmpdir(), "evm-chainlink-price-feeds-"));
  const cwd = process.cwd();
  t.after(async () => {
    process.chdir(cwd);
    await rm(dir, { recursive: true });
  });
  await mkdir(join(dir, "chains", "ethereum"), { recursive: true });
  await writeFile(join(dir, "chains", "ethereum", "addresses.json"), json);
  process.chdir(dir);
}

for (const [holds, json] of [
  ["no aggregators", "{}"],
  ["an empty list of aggregators", '{ "aggregators": [] }'],
]) {
  test(`an addresses.json with ${holds} fails the run`, async (t) => {
    const url = await portal(t, [mockBlock({ number: 1, transactions: [{ logs: [answer(ethUsd!, 1n, 1n, 1n)] }] })]);
    await chdirWithAddresses(t, json!);
    await assert.rejects(records({ PORTAL_URL: url, START_BLOCK: 1 }), {
      message: "chains/ethereum/addresses.json lists no aggregators",
    });
  });
}

test("each chain loads into a table of its own", () => {
  assert.equal(forChain("base").name, "base", "runSource writes to raw.base_chainlink_price_feeds");
  assert.equal(forChain("base").table, "chainlink_price_feeds");
  assert.throws(() => forChain("Base Mainnet"), /chain name/);
});

test("each chain's addresses.json lists the same aggregators as its rows in the chainlink_feeds seed", () => {
  const [header, ...rows] = readFileSync(new URL("../../../../transformation/seeds/chainlink_feeds.csv", import.meta.url), "utf8")
    .trim()
    .split("\n")
    .map((line) => line.split(","));
  const [chainAt, aggregatorAt] = [header!.indexOf("chain"), header!.indexOf("aggregator")];
  const chains = new URL("../chains/", import.meta.url);
  for (const chain of readdirSync(chains)) {
    const { aggregators } = JSON.parse(readFileSync(new URL(`${chain}/addresses.json`, chains), "utf8")) as { aggregators: string[] };
    assert.deepEqual(
      aggregators.map((a) => a.toLowerCase()).sort(),
      rows.filter((row) => row[chainAt] === chain).map((row) => row[aggregatorAt]).sort(),
      `chains/${chain}/addresses.json and transformation/seeds/chainlink_feeds.csv must list the same aggregators`,
    );
  }
});
