import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { getAddressDecoder, type Address } from "@solana/kit";
import { createSolanaClient } from "@ingestion/lib/solana";
import { balanceCalls, fetchBalances } from "#src/balances.ts";

type Request = { id: number; method: string; params: [Address[], unknown] };
type Reply =
  | { result: unknown }
  | { error: { code: number; message: string } }
  | { status: number };

const addressOf = (n: number): Address => {
  const bytes = new Uint8Array(32);
  new DataView(bytes.buffer).setUint32(0, n + 1);
  return getAddressDecoder().decode(bytes);
};

/** A JSON-RPC endpoint that answers each request with `reply`. Returns its URL and the requests it saw. */
async function fakeRpc(t: TestContext, reply: (request: Request) => Reply) {
  const requests: Request[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const request: Request = JSON.parse(body);
    requests.push(request);
    const answer = reply(request);
    if ("status" in answer) {
      res.statusCode = answer.status;
      res.end();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...answer }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
  };
}

/** Answers getMultipleAccounts from `lamports`; an address it lacks has no account. The slot is the number of addresses asked for. */
const accounts =
  (lamports: Map<Address, bigint>) =>
  ({ params: [addresses] }: Request): Reply => ({
    result: {
      context: { slot: addresses.length },
      value: addresses.map((address) => {
        const balance = lamports.get(address);
        return balance === undefined
          ? null
          : {
              lamports: Number(balance),
              data: ["", "base64"],
              executable: false,
              owner: "11111111111111111111111111111111",
              rentEpoch: 0,
              space: 0,
            };
      }),
    },
  });

// No transport retries, so a failed request fails at once rather than after the backoff.
const rpcAt = (url: string) => createSolanaClient(url, { retryCount: 0 });

test("reads 100 wallets per call and records each at its call's slot", async (t) => {
  const wallets = Array.from({ length: 150 }, (_, i) => addressOf(i));
  const noAccount = wallets[5]!;
  const { url, requests } = await fakeRpc(
    t,
    accounts(
      new Map(
        wallets
          .filter((wallet) => wallet !== noAccount)
          .map((wallet, i) => [wallet, BigInt(i) * 10n]),
      ),
    ),
  );

  const batch = await fetchBalances(rpcAt(url), balanceCalls(wallets));

  assert.deepEqual(
    requests.map(({ method, params }) => [method, params[0].length]),
    [
      ["getMultipleAccounts", 100],
      ["getMultipleAccounts", 50],
    ],
  );
  assert.deepEqual(batch.failed, []);
  assert.deepEqual(
    batch.records.slice(4, 7),
    [4, 5, 6].map((i) => ({
      id: `100:${wallets[i]}`,
      callId: wallets[i],
      data: {
        slot: 100n,
        wallet: wallets[i],
        balance: i === 5 ? 0n : BigInt(i < 5 ? i : i - 1) * 10n,
      },
    })),
  );
  assert.deepEqual(batch.records.at(-1), {
    id: `50:${wallets[149]}`,
    callId: wallets[149],
    data: { slot: 50n, wallet: wallets[149], balance: 1480n },
  });
});

test("queues every wallet of a call that fails and keeps the rest", async (t) => {
  const failures: [string, Reply][] = [
    ["JSON-RPC error", { error: { code: -32603, message: "internal error" } }],
    ["HTTP 503", { status: 503 }],
  ];

  for (const [name, failure] of failures) {
    await t.test(name, async (t) => {
      const wallets = Array.from({ length: 101 }, (_, i) => addressOf(i));
      const ok = accounts(new Map(wallets.map((wallet) => [wallet, 1n])));
      const { url } = await fakeRpc(t, (request) =>
        request.params[0].length === 100 ? failure : ok(request),
      );

      const batch = await fetchBalances(rpcAt(url), balanceCalls(wallets));

      assert.deepEqual(
        batch.failed.map(({ id, call }) => ({ id, call })),
        balanceCalls(wallets.slice(0, 100)).map((call) => ({
          id: call.wallet,
          call,
        })),
      );
      assert.deepEqual(
        batch.records.map(({ id, callId }) => ({ id, callId })),
        [{ id: `1:${wallets[100]}`, callId: wallets[100] }],
      );
    });
  }
});

test("asks once for a wallet that a retried call repeats", async (t) => {
  const wallet = addressOf(0);
  const { url, requests } = await fakeRpc(t, accounts(new Map([[wallet, 7n]])));
  const calls = balanceCalls([wallet]);

  const batch = await fetchBalances(rpcAt(url), [...calls, ...calls]);

  assert.deepEqual(
    requests.map(({ params }) => params[0]),
    [[wallet]],
  );
  assert.deepEqual(
    batch.records.map(({ id }) => id),
    [`1:${wallet}`],
  );
});
