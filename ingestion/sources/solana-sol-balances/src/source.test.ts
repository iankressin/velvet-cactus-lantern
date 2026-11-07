import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { solanaSolBalances } from "#src/source.ts";

const wallet = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const otherWallet = "H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS";
const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** Writes `lines` to a temp CSV file and returns its path. */
async function csvFile(t: TestContext, ...lines: string[]) {
  const dir = await mkdtemp(join(tmpdir(), "solana-sol-balances-"));
  t.after(() => rm(dir, { recursive: true }));
  const path = join(dir, "wallet-assets.csv");
  await writeFile(path, lines.join("\n") + "\n");
  return path;
}

const HEADER = "blockchain,wallet_address,token_address";

/** A JSON-RPC endpoint that answers every request with `result`. Returns its URL. */
async function rpcAnswering(t: TestContext, result: unknown) {
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(body).id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const firstBatch = (env: { SOLANA_RPC_URL: string; WALLET_ASSETS_CSV: string }) =>
  solanaSolBalances.extract(env, [])[Symbol.asyncIterator]().next();

const unreachable = "http://127.0.0.1:1";

test("a bad native row fails the run, not the import", async (t) => {
  const path = await csvFile(t, HEADER, `solana,${wallet},`, "solana,nope,");
  await assert.rejects(firstBatch({ SOLANA_RPC_URL: unreachable, WALLET_ASSETS_CSV: path }), {
    message: `Invalid solana native rows in ${path}:\n  line 3: wallet_address "nope" is not a Solana address`,
  });
});

test("a CSV without a wallet_address column fails the run, not the import", async (t) => {
  const path = await csvFile(t, "blockchain,wallet,token_address", `solana,${wallet},`);
  await assert.rejects(firstBatch({ SOLANA_RPC_URL: unreachable, WALLET_ASSETS_CSV: path }), {
    message: `${path} is missing columns: wallet_address; its header is "blockchain,wallet,token_address"`,
  });
});

test("reads only the native rows, so a bad row for another source does not fail the run", async (t) => {
  const path = await csvFile(
    t,
    HEADER,
    `solana,${wallet},`,
    `solana,${otherWallet},${usdc}`,
    `solana,${wallet},nope`,
    "ethereum,nope,",
  );
  // No account exists, so each wallet reads 0.
  const url = await rpcAnswering(t, { context: { slot: 1 }, value: [null] });

  const { value: batch } = await firstBatch({ SOLANA_RPC_URL: url, WALLET_ASSETS_CSV: path });

  assert.deepEqual(batch, {
    records: [{ id: `1:${wallet}`, callId: wallet, data: { slot: 1n, wallet, balance: 0n } }],
    failed: [],
  });
});
