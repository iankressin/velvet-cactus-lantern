import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, address, isSolanaError } from "@solana/kit";
import { createSolanaClient } from "#src/solana/client.ts";

/** An endpoint that hands the nth request (from 1) to `answer`. Returns its URL and a request count. */
async function fakeEndpoint(
  t: TestContext,
  answer: (n: number, id: unknown, res: ServerResponse<IncomingMessage>) => void,
) {
  let requests = 0;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    answer(++requests, JSON.parse(body).id, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests: () => requests,
  };
}

const wallet = address("11111111111111111111111111111111");

for (const status of [429, 503]) {
  test(`an HTTP ${status} reply is not sent again: eRPC sends it after its own retries`, async (t) => {
    const endpoint = await fakeEndpoint(t, (_n, _id, res) => {
      res.statusCode = status;
      res.end();
    });

    await assert.rejects(
      createSolanaClient(endpoint.url, { retryCount: 2 }).getBalance(wallet).send(),
      (error) =>
        isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR) &&
        error.context.statusCode === status,
    );
    assert.equal(endpoint.requests(), 1);
  });
}

test("a request that got no reply is sent again", async (t) => {
  const endpoint = await fakeEndpoint(t, (n, id, res) => {
    if (n === 1) return res.socket?.destroy();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { context: { slot: 7 }, value: 5 } }));
  });

  const { value } = await createSolanaClient(endpoint.url, { retryCount: 2 })
    .getBalance(wallet)
    .send();

  assert.equal(value, 5n);
  assert.equal(endpoint.requests(), 2);
});
