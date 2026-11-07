import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { getAddressDecoder, type Address } from "@solana/kit";
import { createSolanaClient } from "@ingestion/lib/solana";
import { balanceCalls, fetchBalances } from "#src/balances.ts";

type Request = {
  id: number;
  method: string;
  params: [Address, { mint: Address }, unknown];
};
type Reply = { result: unknown } | { error: { code: number; message: string } };

const addressOf = (n: number): Address => {
  const bytes = new Uint8Array(32);
  new DataView(bytes.buffer).setUint32(0, n + 1);
  return getAddressDecoder().decode(bytes);
};

const [walletA, walletB, mint, unknownMint, tokenAccount] = [0, 1, 2, 3, 4].map(addressOf) as [
  Address,
  Address,
  Address,
  Address,
  Address,
];

/** A JSON-RPC endpoint that answers each request with `reply`. Returns its URL. */
async function fakeRpc(t: TestContext, reply: (request: Request) => Reply) {
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const request: Request = JSON.parse(body);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...reply(request) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Answers getTokenAccountsByOwner at slot 7 from `holdings`, keyed `${mint}:${owner}`, one amount per token account. Any mint but `mint` does not exist. */
const ledger =
  (holdings: Record<string, string[]>) =>
  ({ params: [owner, filter] }: Request): Reply =>
    filter.mint !== mint
      ? { error: { code: -32602, message: "Invalid param: could not find mint" } }
      : {
          result: {
            context: { slot: 7 },
            value: (holdings[`${filter.mint}:${owner}`] ?? []).map((amount) => ({
              pubkey: tokenAccount,
              account: {
                lamports: 2039280,
                owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                executable: false,
                rentEpoch: 0,
                space: 165,
                data: {
                  program: "spl-token",
                  space: 165,
                  parsed: {
                    type: "account",
                    info: {
                      mint: filter.mint,
                      owner,
                      isNative: false,
                      state: "initialized",
                      tokenAmount: { amount, decimals: 6, uiAmount: null, uiAmountString: "" },
                    },
                  },
                },
              },
            })),
          },
        };

// No transport retries, so a failed request fails at once rather than after the backoff.
const rpcAt = (url: string) => createSolanaClient(url, { retryCount: 0 });

test("sums a wallet's token accounts for a mint, and records 0 when it has none", async (t) => {
  const url = await fakeRpc(
    t,
    ledger({ [`${mint}:${walletA}`]: ["9007199254740993", "1"] }),
  );

  const batch = await fetchBalances(rpcAt(url), balanceCalls([walletA, walletB], [mint]));

  assert.deepEqual(batch, {
    records: [
      {
        id: `7:${mint}:${walletA}`,
        callId: `${mint}:${walletA}`,
        data: { slot: 7n, mint, wallet: walletA, balance: 9007199254740994n },
      },
      {
        id: `7:${mint}:${walletB}`,
        callId: `${mint}:${walletB}`,
        data: { slot: 7n, mint, wallet: walletB, balance: 0n },
      },
    ],
    failed: [],
  });
});

test("queues the call that fails and keeps the others", async (t) => {
  const url = await fakeRpc(t, ledger({ [`${mint}:${walletA}`]: ["5"] }));

  const batch = await fetchBalances(rpcAt(url), balanceCalls([walletA], [mint, unknownMint]));

  assert.deepEqual(
    batch.records.map(({ id }) => id),
    [`7:${mint}:${walletA}`],
  );
  assert.deepEqual(
    batch.failed.map(({ id, call }) => ({ id, call })),
    [
      {
        id: `${unknownMint}:${walletA}`,
        call: { kind: "spl_balance", mint: unknownMint, wallet: walletA },
      },
    ],
  );
  assert.match(batch.failed[0]!.error, /could not find mint/);
});
