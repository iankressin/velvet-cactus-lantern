import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import {
  decodeAbiParameters,
  decodeFunctionData,
  deploylessCallViaBytecodeBytecode,
  encodeFunctionResult,
  erc20Abi,
  multicall3Abi,
  type Address,
  type Hex,
} from "viem";
import { createEvmClient } from "@ingestion/lib/evm";
import { balanceCallsAt, fetchBalances } from "#src/balances.ts";

const wallet: Address = "0x00000000000000000000000000000000000000aa";
const token = "0x00000000000000000000000000000000000000bb";
const reverting = "0x00000000000000000000000000000000000000cc";
const noCode = "0x00000000000000000000000000000000000000dd";

type Aggregate3Call = { target: Hex; callData: Hex };
type Reply = { result: Hex } | { error: { code: number; message: string } };

/** createEvmClient sends each batch as a deployless call: the deployer bytecode, then abi-encoded (code, aggregate3 calldata). */
function aggregate3Calls(data: Hex): readonly Aggregate3Call[] {
  const [, calldata] = decodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes" }],
    `0x${data.slice(deploylessCallViaBytecodeBytecode.length)}`,
  );
  const decoded = decodeFunctionData({ abi: multicall3Abi, data: calldata });
  if (decoded.functionName !== "aggregate3")
    throw new Error(`unexpected ${decoded.functionName}`);
  return decoded.args[0];
}

/** Answers balanceOf from `balances`, keyed `${block}:${token}:${wallet}`. A missing key replies empty, as an address with no code does. */
const ledger =
  (balances: Record<string, bigint | "revert">) =>
  (block: number, calls: readonly Aggregate3Call[]): Reply => ({
    result: encodeFunctionResult({
      abi: multicall3Abi,
      functionName: "aggregate3",
      result: calls.map(
        ({ target, callData }): { success: boolean; returnData: Hex } => {
          const [owner] = decodeAbiParameters(
            [{ type: "address" }],
            `0x${callData.slice(10)}`,
          );
          const balance =
            balances[`${block}:${target.toLowerCase()}:${owner.toLowerCase()}`];
          if (balance === "revert") return { success: false, returnData: "0x" };
          if (balance === undefined) return { success: true, returnData: "0x" };
          return {
            success: true,
            returnData: encodeFunctionResult({
              abi: erc20Abi,
              functionName: "balanceOf",
              result: balance,
            }),
          };
        },
      ),
    }),
  });

/** A JSON-RPC endpoint that answers each eth_call batch with `reply`. Returns its URL. */
async function fakeRpc(
  t: TestContext,
  reply: (block: number, calls: readonly Aggregate3Call[]) => Reply,
) {
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const answer = ({
      id,
      method,
      params,
    }: {
      id: number;
      method: string;
      params: [{ data: Hex }, Hex];
    }) =>
      method === "eth_call"
        ? {
            jsonrpc: "2.0",
            id,
            ...reply(Number(params[1]), aggregate3Calls(params[0].data)),
          }
        : {
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `unexpected ${method}` },
          };
    const request = JSON.parse(body);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        Array.isArray(request) ? request.map(answer) : answer(request),
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

// No transport retries, so a failed request fails at once rather than after viem's backoff.
const clientAt = (url: string) => createEvmClient(url, { retryCount: 0 });

/** The wallet asset of `tokenAddress` held by `wallet`. */
const holding = (tokenAddress: Address) => ({ walletAddress: wallet, tokenAddress });

test("makes one call per listed wallet asset, not one per wallet and token", () => {
  const vitalik = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
  const binance = "0x28C6c06298d514Db089934071355E5743bf21d60";
  const usdc = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  const dai = "0x6B175474E89094C44Da98b954EedeAC495271d0F";

  const calls = balanceCallsAt(5, [
    { walletAddress: vitalik, tokenAddress: usdc },
    { walletAddress: binance, tokenAddress: dai },
  ]);

  assert.deepEqual(calls, [
    { kind: "erc20_balance", block: 5, token: usdc.toLowerCase(), wallet: vitalik.toLowerCase() },
    { kind: "erc20_balance", block: 5, token: dai.toLowerCase(), wallet: binance.toLowerCase() },
  ]);
});

test("records each balance at its own block", async (t) => {
  const url = await fakeRpc(
    t,
    ledger({ [`5:${token}:${wallet}`]: 42n, [`6:${token}:${wallet}`]: 7n }),
  );

  const batch = await fetchBalances(clientAt(url), [
    ...balanceCallsAt(5, [holding(token)]),
    ...balanceCallsAt(6, [holding(token)]),
  ]);

  assert.deepEqual(batch, {
    records: [
      {
        id: `5:${token}:${wallet}`,
        callId: `5:${token}:${wallet}`,
        data: { block_number: 5, token, wallet, balance: 42n },
      },
      {
        id: `6:${token}:${wallet}`,
        callId: `6:${token}:${wallet}`,
        data: { block_number: 6, token, wallet, balance: 7n },
      },
    ],
    failed: [],
  });
});

test("records null when balanceOf reverts or the token has no code at that block", async (t) => {
  const url = await fakeRpc(
    t,
    ledger({ [`5:${reverting}:${wallet}`]: "revert" }),
  );

  const batch = await fetchBalances(
    clientAt(url),
    balanceCallsAt(5, [holding(reverting), holding(noCode)]),
  );

  assert.deepEqual(batch.failed, []);
  assert.deepEqual(
    batch.records.map(({ data }) => [data.token, data.balance]),
    [
      [reverting, null],
      [noCode, null],
    ],
  );
});

test("keeps one record when a retried call repeats a new one", async (t) => {
  const url = await fakeRpc(t, ledger({ [`5:${token}:${wallet}`]: 42n }));
  const calls = balanceCallsAt(5, [holding(token)]);

  const batch = await fetchBalances(clientAt(url), [...calls, ...calls]);

  assert.deepEqual(
    batch.records.map(({ id }) => id),
    [`5:${token}:${wallet}`],
  );
});

test("queues every call for retry when the batch request itself fails", async (t) => {
  const failures: [string, Reply][] = [
    [
      "internal error (-32603)",
      { error: { code: -32603, message: "upstream request timed out" } },
    ],
    [
      "Multicall3 itself reverts (3)",
      { error: { code: 3, message: "execution reverted" } },
    ],
    ["empty reply to the batch", { result: "0x" }],
  ];

  for (const [name, reply] of failures) {
    await t.test(name, async (t) => {
      const url = await fakeRpc(t, () => reply);
      const calls = balanceCallsAt(5, [holding(token), holding(reverting)]);

      const batch = await fetchBalances(clientAt(url), calls);

      assert.deepEqual(batch.records, []);
      assert.deepEqual(
        batch.failed.map(({ id, call }) => ({ id, call })),
        calls.map((call) => ({ id: `5:${call.token}:${call.wallet}`, call })),
      );
    });
  }
});
