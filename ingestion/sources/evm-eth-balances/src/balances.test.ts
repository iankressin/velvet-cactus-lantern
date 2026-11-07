import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { numberToHex, type Hex } from "viem";
import { createEvmClient } from "@ingestion/lib/evm";
import { balanceCallsAt, fetchBalances } from "#src/balances.ts";

const wallet = "0x00000000000000000000000000000000000000aa";
const other = "0x00000000000000000000000000000000000000bb";

type Reply = { result: Hex } | { error: { code: number; message: string } };

/** Answers eth_getBalance from `balances`, keyed `${block}:${wallet}`. A missing key replies 0, as an address the chain has not seen does. */
const ledger =
  (balances: Record<string, bigint>) =>
  (block: number, address: Hex): Reply => ({
    result: numberToHex(balances[`${block}:${address.toLowerCase()}`] ?? 0n),
  });

/**
 * A JSON-RPC endpoint that answers each eth_getBalance with `reply`, or drops the connection
 * when `reply` is "disconnect". Returns its URL. createEvmClient sends the calls made in one
 * tick as one JSON-RPC batch, so the body is an array.
 */
async function fakeRpc(
  t: TestContext,
  reply: ((block: number, address: Hex) => Reply) | "disconnect",
) {
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (reply === "disconnect") {
      req.socket.destroy();
      return;
    }
    const answer = ({
      id,
      method,
      params,
    }: {
      id: number;
      method: string;
      params: [Hex, Hex];
    }) =>
      method === "eth_getBalance"
        ? { jsonrpc: "2.0", id, ...reply(Number(params[1]), params[0]) }
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

test("records each balance at its own block", async (t) => {
  const url = await fakeRpc(
    t,
    ledger({ [`5:${wallet}`]: 42n, [`6:${wallet}`]: 7n }),
  );

  const batch = await fetchBalances(clientAt(url), [
    ...balanceCallsAt(5, [wallet]),
    ...balanceCallsAt(6, [wallet]),
  ]);

  assert.deepEqual(batch, {
    records: [
      {
        id: `5:${wallet}`,
        callId: `5:${wallet}`,
        data: { block_number: 5, wallet, balance: 42n },
      },
      {
        id: `6:${wallet}`,
        callId: `6:${wallet}`,
        data: { block_number: 6, wallet, balance: 7n },
      },
    ],
    failed: [],
  });
});

test("keeps one record when a retried call repeats a new one", async (t) => {
  const url = await fakeRpc(t, ledger({ [`5:${wallet}`]: 42n }));
  const calls = balanceCallsAt(5, [wallet]);

  const batch = await fetchBalances(clientAt(url), [...calls, ...calls]);

  assert.deepEqual(
    batch.records.map(({ id }) => id),
    [`5:${wallet}`],
  );
});

test("queues a call for retry when its request fails", async (t) => {
  await t.test("the node answers one call with an error", async (t) => {
    const url = await fakeRpc(t, (block, address) =>
      address === other
        ? { error: { code: -32603, message: "upstream request timed out" } }
        : ledger({ [`5:${wallet}`]: 42n })(block, address),
    );
    const calls = balanceCallsAt(5, [wallet, other]);

    const batch = await fetchBalances(clientAt(url), calls);

    assert.deepEqual(
      batch.records.map(({ id }) => id),
      [`5:${wallet}`],
    );
    assert.deepEqual(
      batch.failed.map(({ id, call }) => ({ id, call })),
      [{ id: `5:${other}`, call: calls[1] }],
    );
    assert.match(batch.failed[0]!.error, /upstream request timed out/);
  });

  await t.test("the connection drops", async (t) => {
    const url = await fakeRpc(t, "disconnect");
    const calls = balanceCallsAt(5, [wallet, other]);

    const batch = await fetchBalances(clientAt(url), calls);

    assert.deepEqual(batch.records, []);
    assert.deepEqual(
      batch.failed.map(({ id, call }) => ({ id, call })),
      calls.map((call) => ({ id: `5:${call.wallet}`, call })),
    );
  });
});
