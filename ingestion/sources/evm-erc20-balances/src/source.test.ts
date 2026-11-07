import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { forChain } from "#src/source.ts";

const vitalik = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const usdc = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

/** Writes a wallet asset CSV with these rows under its header. Returns its path. */
async function walletAssets(t: TestContext, ...rows: string[]) {
  const dir = await mkdtemp(join(tmpdir(), "evm-erc20-balances-"));
  t.after(() => rm(dir, { recursive: true }));
  const path = join(dir, "wallet-assets.csv");
  await writeFile(path, ["blockchain,wallet_address,token_address", ...rows].join("\n") + "\n");
  return path;
}

/** A node that turns every request away at once. Each call a run makes comes back failed, which shows the calls it made. */
async function refusingNode(t: TestContext) {
  const server = createServer((req, res) => {
    res.statusCode = 400;
    req.resume().on("end", () => res.end());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** The first batch of a run on `chain`, its settings parsed by the source, as runSource parses them. */
async function firstBatch(chain: string, settings: { WALLET_ASSETS_CSV: string; EVM_RPC_URL?: string }) {
  const source = forChain(chain);
  const env = source.env.parse({ BLOCK_NUMBER: "5", EVM_RPC_URL: "http://127.0.0.1:1", ...settings });
  for await (const batch of source.extract(env, [])) return batch;
}

test("a bad erc20 row is skipped, and the run reads the rest", async (t) => {
  const csv = await walletAssets(t, `ethereum,${vitalik},${usdc}`, `ethereum,${vitalik},0xnot`);

  const batch = await firstBatch("ethereum", { WALLET_ASSETS_CSV: csv, EVM_RPC_URL: await refusingNode(t) });

  assert.deepEqual(
    batch?.failed.map(({ call }) => call),
    [{ kind: "erc20_balance", block: 5, token: usdc.toLowerCase(), wallet: vitalik.toLowerCase() }],
  );
});

test("a bad row that only another source reads does not fail this one", async (t) => {
  const csv = await walletAssets(t, "ethereum,0xnot,", `ethereum,${vitalik},${usdc}`);

  const batch = await firstBatch("ethereum", { WALLET_ASSETS_CSV: csv, EVM_RPC_URL: await refusingNode(t) });

  assert.deepEqual(
    batch?.failed.map(({ call }) => call),
    [{ kind: "erc20_balance", block: 5, token: usdc.toLowerCase(), wallet: vitalik.toLowerCase() }],
  );
});

test("a chain the wallet asset CSV cannot hold yet still builds, and only its run fails", async (t) => {
  const csv = await walletAssets(t, `ethereum,${vitalik},${usdc}`);
  assert.equal(forChain("base").name, "base", "generate-sources-json builds every chain in chains/");
  await assert.rejects(firstBatch("base", { WALLET_ASSETS_CSV: csv }), {
    name: "ZodError",
    message: /Invalid input: expected \\"ethereum\\"/,
  });
});

test("each chain loads into a table of its own", () => {
  assert.equal(forChain("ethereum").name, "ethereum", "runSource writes to raw.ethereum_erc20_balances");
  assert.equal(forChain("ethereum").table, "erc20_balances");
  assert.throws(() => forChain("Ethereum Mainnet"), /chain name/);
});
