import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { solanaSplBalances } from "#src/source.ts";

const wallet = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const otherWallet = "H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS";
const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** Writes `lines` to a temp CSV file and returns its path. */
async function csvFile(t: TestContext, ...lines: string[]) {
  const dir = await mkdtemp(join(tmpdir(), "solana-spl-balances-"));
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
  solanaSplBalances.extract(env, [])[Symbol.asyncIterator]().next();

const unreachable = "http://127.0.0.1:1";

test("a bad spl row is skipped, and the run reads the rest", async (t) => {
  const path = await csvFile(t, HEADER, `solana,${wallet},${usdc}`, `solana,nope,${usdc}`);
  // The wallet holds no token account for the mint, so it reads 0.
  const url = await rpcAnswering(t, { context: { slot: 1 }, value: [] });

  const { value: batch } = await firstBatch({ SOLANA_RPC_URL: url, WALLET_ASSETS_CSV: path });

  assert.deepEqual(batch, {
    records: [
      {
        id: `1:${usdc}:${wallet}`,
        callId: `${usdc}:${wallet}`,
        data: { slot: 1n, mint: usdc, wallet, balance: 0n },
      },
    ],
    failed: [],
  });
});

test("a CSV without a token_address column fails the run, not the import", async (t) => {
  const path = await csvFile(t, "blockchain,wallet_address,mint", `solana,${wallet},${usdc}`);
  await assert.rejects(firstBatch({ SOLANA_RPC_URL: unreachable, WALLET_ASSETS_CSV: path }), {
    message: `${path} is missing columns: token_address; its header is "blockchain,wallet_address,mint"`,
  });
});

test("reads only the spl rows, so a bad row for another source does not fail the run", async (t) => {
  const path = await csvFile(
    t,
    HEADER,
    `solana,${wallet},${usdc}`,
    `solana,${otherWallet},`,
    "solana,nope,",
  );
  // The wallet holds no token account for the mint, so it reads 0.
  const url = await rpcAnswering(t, { context: { slot: 1 }, value: [] });

  const { value: batch } = await firstBatch({ SOLANA_RPC_URL: url, WALLET_ASSETS_CSV: path });

  assert.deepEqual(batch, {
    records: [
      {
        id: `1:${usdc}:${wallet}`,
        callId: `${usdc}:${wallet}`,
        data: { slot: 1n, mint: usdc, wallet, balance: 0n },
      },
    ],
    failed: [],
  });
});
