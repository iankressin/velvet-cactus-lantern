import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import {
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED,
  isSolanaError,
  type Address,
} from "@solana/kit";
import { settleCalls } from "#src/calls.ts";
import { createSolanaClient } from "#src/solana/client.ts";

/** A JSON-RPC endpoint that answers every request with `error`. Returns its URL. */
async function failingRpc(t: TestContext, error: { code: number; message: string }) {
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(body).id, error }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const owner = "11111111111111111111111111111111" as Address;

async function failedCall(url: string) {
  const rpc = createSolanaClient(url);
  const { failed } = await settleCalls([owner], String, async (wallet) => {
    await rpc.getTokenAccountsByOwner(wallet, { mint: owner }).send();
    return {};
  });
  return failed[0]!.error;
}

test("a JSON-RPC error code that kit has no message for keeps the code and the server's message", async (t) => {
  const url = await failingRpc(t, {
    code: -32000,
    message: "all upstream attempts failed (3 upstream rate limited)",
  });

  assert.match(
    await failedCall(url),
    /-32000.*all upstream attempts failed \(3 upstream rate limited\)/,
  );
});

test("a JSON-RPC error code that kit knows stays a SolanaError", async (t) => {
  const code = SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED;
  const url = await failingRpc(t, { code, message: "Minimum context slot has not been reached" });

  await assert.rejects(
    createSolanaClient(url).getTokenAccountsByOwner(owner, { mint: owner }).send(),
    (error) => isSolanaError(error, code),
  );
});
