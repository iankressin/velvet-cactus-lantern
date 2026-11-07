import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  decodeAbiParameters,
  decodeFunctionData,
  deploylessCallViaBytecodeBytecode,
  encodeFunctionResult,
  erc20Abi,
  getAddress,
  multicall3Abi,
  type Hex,
} from "viem";
import { createEvmClient } from "@ingestion/lib/evm";
import { fetchMetadata, forChain, metadataCallsAt } from "#src/source.ts";

const usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const mkr = "0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2";
const noDecimals = "0x00000000000000000000000000000000000000cc";
const noCode = "0x00000000000000000000000000000000000000dd";

// MKR's symbol() on Ethereum mainnet: "MKR" as a bytes32, padded with zero bytes.
const MKR_SYMBOL = "0x4d4b520000000000000000000000000000000000000000000000000000000000";
const MKR_NAME = "0x4d616b6572000000000000000000000000000000000000000000000000000000";

const name = (result: string) => encodeFunctionResult({ abi: erc20Abi, functionName: "name", result });
const symbol = (result: string) => encodeFunctionResult({ abi: erc20Abi, functionName: "symbol", result });
const decimals = (result: number) => encodeFunctionResult({ abi: erc20Abi, functionName: "decimals", result });

type Read = "name" | "symbol" | "decimals";
/** Each token's replies, keyed `${block}:${token}`. A read left out replies empty, as an address with no code does. */
type Chain = Record<string, Partial<Record<Read, Hex | "revert">>>;
type Aggregate3Call = { target: Hex; callData: Hex };
type Reply = { result: Hex } | { error: { code: number; message: string } };

/** createEvmClient sends each batch as a deployless call: the deployer bytecode, then abi-encoded (code, aggregate3 calldata). */
function aggregate3Calls(data: Hex): readonly Aggregate3Call[] {
  const [, calldata] = decodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes" }],
    `0x${data.slice(deploylessCallViaBytecodeBytecode.length)}`,
  );
  const decoded = decodeFunctionData({ abi: multicall3Abi, data: calldata });
  if (decoded.functionName !== "aggregate3") throw new Error(`unexpected ${decoded.functionName}`);
  return decoded.args[0];
}

const answering =
  (chain: Chain) =>
  (block: number, calls: readonly Aggregate3Call[]): Reply => ({
    result: encodeFunctionResult({
      abi: multicall3Abi,
      functionName: "aggregate3",
      result: calls.map(({ target, callData }): { success: boolean; returnData: Hex } => {
        const { functionName } = decodeFunctionData({ abi: erc20Abi, data: callData });
        const reply = chain[`${block}:${target.toLowerCase()}`]?.[functionName as Read] ?? "0x";
        return reply === "revert" ? { success: false, returnData: "0x" } : { success: true, returnData: reply };
      }),
    }),
  });

/** A JSON-RPC node that answers each eth_call with `reply`. Returns its URL and the block of every eth_call it got. */
async function node(t: TestContext, reply: (block: number, calls: readonly Aggregate3Call[]) => Reply) {
  const blocks: Hex[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const answer = ({ id, method, params }: { id: number; method: string; params: [{ data: Hex }, Hex] }) => {
      if (method !== "eth_call") return { jsonrpc: "2.0", id, error: { code: -32601, message: `unexpected ${method}` } };
      blocks.push(params[1]);
      return { jsonrpc: "2.0", id, ...reply(Number(params[1]), aggregate3Calls(params[0].data)) };
    };
    const request = JSON.parse(body);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(Array.isArray(request) ? request.map(answer) : answer(request)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, blocks };
}

// No transport retries, so a failed request fails at once rather than after viem's backoff.
const clientAt = (url: string) => createEvmClient(url, { retryCount: 0 });

test("decodes a string reply, and a bytes32 reply without its zero padding", async (t) => {
  const { url } = await node(
    t,
    answering({
      [`5:${usdc}`]: { name: name("USD Coin"), symbol: symbol("USDC"), decimals: decimals(6) },
      [`5:${mkr}`]: { name: MKR_NAME, symbol: MKR_SYMBOL, decimals: decimals(18) },
    }),
  );

  // addresses.json may hold checksummed addresses; ids and records use lower case.
  const batch = await fetchMetadata(clientAt(url), metadataCallsAt(5, [getAddress(usdc), getAddress(mkr)]));

  assert.deepEqual(batch, {
    records: [
      {
        id: `5:${usdc}`,
        callId: `5:${usdc}`,
        data: { block_number: 5, token: usdc, name: "USD Coin", symbol: "USDC", decimals: 6 },
      },
      {
        id: `5:${mkr}`,
        callId: `5:${mkr}`,
        data: { block_number: 5, token: mkr, name: "Maker", symbol: "MKR", decimals: 18 },
      },
    ],
    failed: [],
  });
});

test("queues a truncated string reply for retry instead of decoding it as bytes32", async (t) => {
  const truncatedString: Hex = `0x${"0".repeat(62)}20${"0".repeat(63)}1`;
  const { url } = await node(
    t,
    answering({ [`5:${usdc}`]: { name: truncatedString, symbol: symbol("USDC"), decimals: decimals(6) } }),
  );

  const batch = await fetchMetadata(clientAt(url), metadataCallsAt(5, [usdc]));

  assert.deepEqual(batch.records, []);
  assert.deepEqual(batch.failed.map(({ id }) => id), [`5:${usdc}`]);
});

test("drops zero bytes inside a string, and records null for a name that is only zero bytes", async (t) => {
  const { url } = await node(
    t,
    answering({ [`5:${usdc}`]: { name: `0x${"00".repeat(32)}`, symbol: symbol("US\u0000DC\u0000"), decimals: decimals(6) } }),
  );

  const batch = await fetchMetadata(clientAt(url), metadataCallsAt(5, [usdc]));

  assert.deepEqual(
    batch.records.map(({ data }) => [data.name, data.symbol]),
    [[null, "USDC"]],
    "no zero byte reaches the jsonb column, and an empty name is null",
  );
});

test("records null when a read reverts or the token has no code, without failing the call", async (t) => {
  const { url } = await node(
    t,
    answering({ [`5:${noDecimals}`]: { name: name("Old Token"), symbol: symbol("OLD"), decimals: "revert" } }),
  );

  const batch = await fetchMetadata(clientAt(url), metadataCallsAt(5, [noDecimals, noCode]));

  assert.deepEqual(batch.failed, [], "a revert or an empty reply at a pinned block is a fact, not a failed call");
  assert.deepEqual(
    batch.records.map(({ data }) => data),
    [
      { block_number: 5, token: noDecimals, name: "Old Token", symbol: "OLD", decimals: null },
      { block_number: 5, token: noCode, name: null, symbol: null, decimals: null },
    ],
  );
});

test("reads each call at its own block, every read of a block in one eth_call", async (t) => {
  const { url, blocks } = await node(
    t,
    answering({
      [`5:${usdc}`]: { name: name("USD Coin"), symbol: symbol("USDC"), decimals: decimals(6) },
      [`6:${usdc}`]: { name: name("USD Coin v2"), symbol: symbol("USDC2"), decimals: decimals(6) },
    }),
  );

  const batch = await fetchMetadata(clientAt(url), [...metadataCallsAt(5, [usdc]), ...metadataCallsAt(6, [usdc])]);

  assert.deepEqual(
    batch.records.map(({ data }) => [data.block_number, data.symbol]),
    [
      [5, "USDC"],
      [6, "USDC2"],
    ],
    "a retried call reads the block it missed, not the new calls' block",
  );
  assert.deepEqual([...blocks].sort(), ["0x5", "0x6"], "one Multicall3 call per block");
});

test("queues every call for retry when the batch request itself fails", async (t) => {
  const failures: [string, Reply][] = [
    ["internal error (-32603)", { error: { code: -32603, message: "upstream request timed out" } }],
    ["Multicall3 itself reverts (3)", { error: { code: 3, message: "execution reverted" } }],
    ["empty reply to the batch", { result: "0x" }],
  ];

  for (const [label, reply] of failures) {
    await t.test(label, async (t) => {
      const { url } = await node(t, () => reply);

      const batch = await fetchMetadata(clientAt(url), metadataCallsAt(5, [usdc, noDecimals]));

      assert.deepEqual(batch.records, [], "an RPC error is not recorded as a token without metadata");
      assert.deepEqual(
        batch.failed.map(({ id }) => id),
        [`5:${usdc}`, `5:${noDecimals}`],
        "each failed call waits for the next run under its record's id",
      );
    });
  }
});

const env = { BLOCK_NUMBER: "latest", EVM_RPC_URL: "http://127.0.0.1:1", RPC_BATCH_SIZE: 1, RPC_MAX_CONCURRENCY: 1 } as const;

/** Runs the rest of the test from a folder whose chains/ethereum/addresses.json holds `json`, as a source runs from its package. */
async function addressesHold(t: TestContext, json: string) {
  const dir = await mkdtemp(join(tmpdir(), "evm-erc20-metadata-"));
  const cwd = process.cwd();
  t.after(async () => {
    process.chdir(cwd);
    await rm(dir, { recursive: true });
  });
  await mkdir(join(dir, "chains", "ethereum"), { recursive: true });
  await writeFile(join(dir, "chains", "ethereum", "addresses.json"), json);
  process.chdir(dir);
}

const firstBatch = () => forChain("ethereum").extract(env, [])[Symbol.asyncIterator]().next();

test("a bad address in addresses.json fails the run, not the import", async (t) => {
  await addressesHold(t, JSON.stringify({ tokens: ["0xnot-an-address"] }));
  await assert.rejects(firstBatch(), { message: "Invalid Ethereum addresses:\n  0xnot-an-address" });
});

test("malformed addresses.json fails the run, not the import", async (t) => {
  await addressesHold(t, '{ "tokens": [], }');
  await assert.rejects(firstBatch(), /chains\/ethereum\/addresses\.json is not valid JSON/);
});

test("each chain loads into a table of its own", () => {
  assert.equal(forChain("ethereum").name, "ethereum", "runSource writes to raw.ethereum_erc20_metadata");
  assert.equal(forChain("ethereum").table, "erc20_metadata");
  assert.throws(() => forChain("Ethereum Mainnet"), /chain name/);
});
