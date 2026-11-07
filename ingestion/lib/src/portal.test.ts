import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { finalizedHead, portalClient } from "#src/portal.ts";

/** A local Portal that answers its finalized head and keeps the headers of each request. */
async function portal(t: TestContext) {
  const requests: IncomingHttpHeaders[] = [];
  const server = createServer((req, res) => {
    requests.push(req.headers);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ number: 42, hash: "0xabc" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

test("an API key goes with every request in x-api-key", async (t) => {
  const { url, requests } = await portal(t);
  assert.equal(await finalizedHead(portalClient(url, "sqd_prt_test")), 42);
  assert.equal(requests[0]!["x-api-key"], "sqd_prt_test");
});

test("without an API key, requests carry none", async (t) => {
  const { url, requests } = await portal(t);
  assert.equal(await finalizedHead(portalClient(url)), 42);
  assert.equal(requests[0]!["x-api-key"], undefined);
});
