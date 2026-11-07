import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { bitcoinAddress, createBitcoinClient, scriptPubKey } from "@ingestion/lib/bitcoin";
import { balanceCalls, fetchBalances } from "#src/balances.ts";

type Request = { jsonrpc: string; id: number; method: string; params: [string, string[]] };
type Reply =
  | { result: unknown }
  | { error: { code: number; message: string } }
  | { status: number };

/** A JSON-RPC endpoint that answers each request with `reply`. Returns its URL and the requests it saw. */
async function fakeRpc(t: TestContext, reply: Reply) {
  const requests: Request[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const request: Request = JSON.parse(body);
    requests.push(request);
    if ("status" in reply) {
      res.statusCode = reply.status;
      res.end();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...reply }));
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

/** A finished scan at height 900000 that found `unspents`, each with its script, desc and amount in BTC. */
const scanned = (unspents: { scriptPubKey: string; desc: string; amount: number }[]): Reply => ({
  result: {
    success: true,
    txouts: 1000,
    height: 900_000,
    bestblock: "00".repeat(32),
    unspents: unspents.map((unspent, vout) => ({
      txid: "11".repeat(32),
      vout,
      coinbase: false,
      height: 899_000,
      ...unspent,
    })),
    total_amount: unspents.reduce((sum, { amount }) => sum + amount, 0),
  },
});

/** A wallet and the script a node reports for it. The lib's address test checks scriptPubKey against a node. */
const wallet = (address: string) => {
  const parsed = bitcoinAddress.parse(address);
  return { address: parsed, script: scriptPubKey(parsed) };
};
const p2pkh = wallet("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa");
const p2sh = wallet("34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo");
const p2wpkh = wallet("bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h");
const p2wsh = wallet("bc1qgdjqv0av3q56jvd82tkdjpy7gdp9ut8tlqmgrpmv24sq90ecnvqqjwvw97");
const p2tr = wallet("bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr");
const wallets = [p2pkh, p2sh, p2wpkh, p2wsh, p2tr].map(({ address }) => address);

test("reads every wallet in one scan and sums each wallet's unspents by script", async (t) => {
  const { url, requests } = await fakeRpc(
    t,
    scanned([
      { scriptPubKey: p2pkh.script, desc: `addr(${p2pkh.address})#0`, amount: 50 },
      { scriptPubKey: p2wpkh.script, desc: `addr(${p2wpkh.address})#0`, amount: 0.1 },
      { scriptPubKey: p2wpkh.script, desc: `addr(${p2wpkh.address})#0`, amount: 0.2 },
      { scriptPubKey: p2wsh.script, desc: `addr(${p2wsh.address})#0`, amount: 1.23456789 },
      { scriptPubKey: p2tr.script, desc: `rawtr(${p2tr.script.slice(4)})#0`, amount: 0.00006187 },
    ]),
  );

  const batch = await fetchBalances(createBitcoinClient(url), balanceCalls(wallets));

  assert.deepEqual(
    requests.map(({ jsonrpc, method, params }) => ({ jsonrpc, method, params })),
    [
      {
        jsonrpc: "2.0",
        method: "scantxoutset",
        params: ["start", wallets.map((wallet) => `addr(${wallet})`)],
      },
    ],
  );
  assert.deepEqual(batch.failed, []);
  const balances = [5_000_000_000n, 0n, 30_000_000n, 123_456_789n, 6_187n];
  assert.deepEqual(
    batch.records,
    wallets.map((wallet, i) => ({
      id: `900000:${wallet}`,
      callId: wallet,
      data: { block_number: 900_000, wallet, balance: balances[i] },
    })),
  );
});

test("fails every wallet and writes no record when the scan fails", async (t) => {
  const failures: [string, Reply, RegExp][] = [
    ["JSON-RPC error", { error: { code: -8, message: "Scan already in progress" } }, /Scan already in progress/],
    ["HTTP 503", { status: 503 }, /HTTP 503/],
    ["aborted scan", { result: { success: false } }, /aborted/],
    [
      "unspent that no wallet's script matches",
      scanned([{ scriptPubKey: "51", desc: "raw(51)#0", amount: 1 }]),
      /no wallet/,
    ],
  ];

  for (const [name, failure, error] of failures) {
    await t.test(name, async (t) => {
      const { url } = await fakeRpc(t, failure);

      const batch = await fetchBalances(createBitcoinClient(url), balanceCalls(wallets));

      assert.deepEqual(batch.records, []);
      assert.deepEqual(
        batch.failed.map(({ id, call }) => ({ id, call })),
        balanceCalls(wallets).map((call) => ({ id: call.wallet, call })),
      );
      for (const failed of batch.failed) assert.match(failed.error, error);
    });
  }
});

test("asks once for a wallet that a retried call repeats", async (t) => {
  const { url, requests } = await fakeRpc(t, scanned([]));
  const calls = balanceCalls(wallets.slice(0, 1));

  const batch = await fetchBalances(createBitcoinClient(url), [...calls, ...calls]);

  assert.deepEqual(
    requests.map(({ params }) => params[1]),
    [[`addr(${wallets[0]})`]],
  );
  assert.deepEqual(
    batch.records.map(({ id }) => id),
    [`900000:${wallets[0]}`],
  );
});
