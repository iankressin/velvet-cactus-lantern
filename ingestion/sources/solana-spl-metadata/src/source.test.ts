import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { solanaSplMetadata } from "#src/source.ts";

const wallet = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const otherWallet = "H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS";
const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const usdt = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const pyusd = "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo";
const unreachable = "http://127.0.0.1:1";

/**
 * Runs the rest of the test from a folder laid out like the package: addresses.json holds `addresses`,
 * and wallet-assets.csv holds `rows` under its header. Returns the CSV's path.
 */
async function packageFolder(t: TestContext, addresses: string, ...rows: string[]) {
  const dir = await mkdtemp(join(tmpdir(), "solana-spl-metadata-"));
  const cwd = process.cwd();
  t.after(async () => {
    process.chdir(cwd);
    await rm(dir, { recursive: true });
  });
  await writeFile(join(dir, "addresses.json"), addresses);
  const csv = join(dir, "wallet-assets.csv");
  await writeFile(csv, ["blockchain,wallet_address,token_address", ...rows].join("\n") + "\n");
  process.chdir(dir);
  return csv;
}

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

/** The first batch of a run with `env`. */
async function firstBatch(env: { SOLANA_RPC_URL: string; WALLET_ASSETS_CSV: string }) {
  for await (const batch of solanaSplMetadata.extract(env, [])) return batch;
}

test("reads each spl mint in the wallet asset CSV and in addresses.json once", async (t) => {
  const csv = await packageFolder(
    t,
    JSON.stringify({ mints: [usdc, pyusd] }),
    `solana,${wallet},`,
    `solana,${wallet},${usdc}`,
    `solana,${otherWallet},${usdc}`,
    `solana,${wallet},${usdt}`,
    // A bad row that only solana-sol-balances reads.
    "solana,nope,",
  );
  // No account at the mint or its Metaplex address, so each mint reads as nulls.
  const url = await rpcAnswering(t, { context: { slot: 1 }, value: [null, null] });

  const batch = await firstBatch({ SOLANA_RPC_URL: url, WALLET_ASSETS_CSV: csv });

  assert.deepEqual(
    batch?.records.map(({ data }) => data.mint),
    [usdc, usdt, pyusd],
    "the CSV's mints first, then addresses.json's, each once",
  );
  assert.deepEqual(batch?.failed, []);
});

test("a bad spl row is skipped, and the run reads the rest", async (t) => {
  const csv = await packageFolder(t, JSON.stringify({ mints: [] }), `solana,${wallet},${usdc}`, `solana,${wallet},nope`);
  // No account at the mint or its Metaplex address, so the mint reads as nulls.
  const url = await rpcAnswering(t, { context: { slot: 1 }, value: [null, null] });

  const batch = await firstBatch({ SOLANA_RPC_URL: url, WALLET_ASSETS_CSV: csv });

  assert.deepEqual(batch?.records.map(({ data }) => data.mint), [usdc]);
  assert.deepEqual(batch?.failed, []);
});

test("a bad mint in addresses.json fails the run, not the import", async (t) => {
  const csv = await packageFolder(t, JSON.stringify({ mints: ["not-an-address"] }), `solana,${wallet},`);
  await assert.rejects(firstBatch({ SOLANA_RPC_URL: unreachable, WALLET_ASSETS_CSV: csv }), {
    message: "Invalid Solana addresses:\n  not-an-address",
  });
});

test("malformed addresses.json fails the run, not the import", async (t) => {
  const csv = await packageFolder(t, '{ "mints": [], }', `solana,${wallet},`);
  await assert.rejects(firstBatch({ SOLANA_RPC_URL: unreachable, WALLET_ASSETS_CSV: csv }), /addresses\.json is not valid JSON/);
});

test("loads raw.solana_spl_metadata", () => {
  assert.equal(solanaSplMetadata.name, "solana");
  assert.equal(solanaSplMetadata.table, "spl_metadata");
});
