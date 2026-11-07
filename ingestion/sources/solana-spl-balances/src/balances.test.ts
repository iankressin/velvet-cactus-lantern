import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { getAddressDecoder, type Address } from "@solana/kit";
import { createSolanaClient } from "@ingestion/lib/solana";
import { TOKEN_PROGRAMS, balanceCalls, fetchBalances } from "#src/balances.ts";

type Request = {
  id: number;
  method: string;
  params: [Address, { programId: Address }, unknown];
};
type Reply = { result: unknown } | { error: { code: number; message: string } };

const addressOf = (n: number): Address => {
  const bytes = new Uint8Array(32);
  new DataView(bytes.buffer).setUint32(0, n + 1);
  return getAddressDecoder().decode(bytes);
};

const [walletA, walletB, mint, otherMint, tokenAccount] = [0, 1, 2, 3, 4].map(addressOf) as [
  Address,
  Address,
  Address,
  Address,
  Address,
];
const [tokenProgram, token2022Program] = TOKEN_PROGRAMS as [Address, Address];

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

type Holding = { mint: Address; program: Address; amount: string };

/** Answers getTokenAccountsByOwner at slot 7 with the token accounts `holdings` lists for the owner
 * under the asked program, and records each request in `requests`. A wallet in `broken` gets an error. */
const ledger =
  (
    holdings: Record<string, Holding[]>,
    requests: Request[] = [],
    broken: Address[] = [],
    slotForProgram: (program: Address) => number = () => 7,
  ) =>
  (request: Request): Reply => {
    requests.push(request);
    const [owner, { programId }] = request.params;
    if (broken.includes(owner)) return { error: { code: -32000, message: "rate-limit exceeded" } };
    return {
      result: {
        context: { slot: slotForProgram(programId) },
        value: (holdings[owner] ?? [])
          .filter(({ program }) => program === programId)
          .map(({ mint, amount }) => ({
            pubkey: tokenAccount,
            account: {
              lamports: 2039280,
              owner: programId,
              executable: false,
              rentEpoch: 0,
              space: 165,
              data: {
                program: "spl-token",
                space: 165,
                parsed: {
                  type: "account",
                  info: {
                    mint,
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
  };

// No transport retries, so a failed request fails at once rather than after the backoff.
const rpcAt = (url: string) => createSolanaClient(url, { retryCount: 0 });

/** A wallet asset row as the CSV lists it: a wallet and one mint. */
const held = (walletAddress: Address, tokenAddress: Address) => ({ walletAddress, tokenAddress });

test("makes one call per listed wallet and mint, not one per wallet for every mint", () => {
  assert.deepEqual(balanceCalls([held(walletA, mint), held(walletB, otherMint)]), [
    { kind: "spl_balance", mint, wallet: walletA },
    { kind: "spl_balance", mint: otherMint, wallet: walletB },
  ]);
});

test("reads each wallet once per token program, however many of its mints are listed", async (t) => {
  const requests: Request[] = [];
  const url = await fakeRpc(t, ledger({}, requests));

  await fetchBalances(
    rpcAt(url),
    balanceCalls([held(walletA, mint), held(walletA, otherMint), held(walletB, mint)]),
  );

  assert.deepEqual(
    requests.map(({ method, params: [owner, { programId }] }) => `${method}:${owner}:${programId}`).sort(),
    [
      `getTokenAccountsByOwner:${walletA}:${tokenProgram}`,
      `getTokenAccountsByOwner:${walletA}:${token2022Program}`,
      `getTokenAccountsByOwner:${walletB}:${tokenProgram}`,
      `getTokenAccountsByOwner:${walletB}:${token2022Program}`,
    ].sort(),
  );
});

test("sums a wallet's token accounts for a mint under both programs, and records 0 when it has none", async (t) => {
  const url = await fakeRpc(
    t,
    ledger({
      [walletA]: [
        { mint, program: tokenProgram, amount: "9007199254740993" },
        { mint, program: token2022Program, amount: "1" },
        { mint: otherMint, program: tokenProgram, amount: "5" },
      ],
    }),
  );

  const batch = await fetchBalances(rpcAt(url), balanceCalls([held(walletA, mint), held(walletB, mint)]));

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

test("uses each mint's latest reply slot and the later reply slot for absent mints", async (t) => {
  const url = await fakeRpc(
    t,
    ledger(
      { [walletA]: [{ mint, program: tokenProgram, amount: "5" }] },
      [],
      [],
      (program) => (program === tokenProgram ? 100 : 110),
    ),
  );

  const batch = await fetchBalances(
    rpcAt(url),
    balanceCalls([held(walletA, mint), held(walletA, otherMint)]),
  );

  assert.deepEqual(
    batch.records.map(({ id, data: { slot, balance } }) => ({ id, slot, balance })),
    [
      { id: `100:${mint}:${walletA}`, slot: 100n, balance: 5n },
      { id: `110:${otherMint}:${walletA}`, slot: 110n, balance: 0n },
    ],
  );
});

test("queues every call of a wallet whose read fails and keeps the other wallets", async (t) => {
  const url = await fakeRpc(
    t,
    ledger({ [walletB]: [{ mint, program: tokenProgram, amount: "5" }] }, [], [walletA]),
  );

  const batch = await fetchBalances(
    rpcAt(url),
    balanceCalls([held(walletA, mint), held(walletA, otherMint), held(walletB, mint)]),
  );

  assert.deepEqual(
    batch.records.map(({ id }) => id),
    [`7:${mint}:${walletB}`],
  );
  assert.deepEqual(
    batch.failed.map(({ id }) => id),
    [`${mint}:${walletA}`, `${otherMint}:${walletA}`],
  );
  assert.match(batch.failed[0]!.error, /rate-limit exceeded/);
});
