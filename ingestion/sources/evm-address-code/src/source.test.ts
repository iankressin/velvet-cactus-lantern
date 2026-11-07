import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { createEvmClient } from "@ingestion/lib/evm";
import { forChain, codeCallsAt, fetchCode } from "#src/source.ts";

const contract = "0x00000000000000000000000000000000000000aa";
const wallet = "0x00000000000000000000000000000000000000bb";
const flaky = "0x00000000000000000000000000000000000000cc";
const CODE = "0x6080604052";

type Request = { id: number; method: string; params: [string, string] };

/** A local JSON-RPC node: eth_getCode answers CODE for `contract`, nothing for `wallet`, an error for `flaky`. */
async function node(t: TestContext) {
  const asked: Request[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const parsed = JSON.parse(body) as Request | Request[];
      const requests = Array.isArray(parsed) ? parsed : [parsed];
      asked.push(...requests);
      const replies = requests.map(({ id, params: [address] }) =>
        address === flaky
          ? { jsonrpc: "2.0", id, error: { code: -32000, message: "header not found" } }
          : { jsonrpc: "2.0", id, result: address === contract ? CODE : "0x" },
      );
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(parsed) ? replies : replies[0]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, asked };
}

test("each address's code is recorded at the call's block, and an address with none gets 0x", async (t) => {
  const { url, asked } = await node(t);
  const client = createEvmClient(url, { retryCount: 0 });
  const batch = await fetchCode(client, codeCallsAt(120, [contract, wallet, flaky]));

  assert.deepEqual(
    batch.records.map(({ id, data }) => ({ id, ...data })),
    [
      { id: `120:${contract}`, block_number: 120, address: contract, code: CODE },
      { id: `120:${wallet}`, block_number: 120, address: wallet, code: "0x" },
    ],
  );
  assert.deepEqual(batch.failed.map((f) => f.id), [`120:${flaky}`], "a failed read waits for the next run");
  assert.ok(asked.every((r) => r.method === "eth_getCode" && r.params[1] === "0x78"), "every read is pinned to block 120");
});

test("each chain loads into a table of its own", () => {
  assert.equal(forChain("arbitrum").name, "arbitrum", "runSource writes to raw.arbitrum_address_code");
  assert.equal(forChain("arbitrum").table, "address_code");
  assert.throws(() => forChain("Arbitrum One"), /chain name/);
});
