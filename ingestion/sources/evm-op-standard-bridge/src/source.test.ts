import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { RawRecord } from "@ingestion/lib";
import { mockPortal } from "@subsquid/pipes/testing";
import { encodeEvent, mockBlock } from "@subsquid/pipes/testing/evm";
import type { Abi, Hex } from "viem";
import bridgeAbi from "../../../../catalog/protocols/op-standard-bridge/abis/l2-standard-bridge.json" with { type: "json" };
import addresses from "../chains/base/addresses.json" with { type: "json" };
import { BRIDGES, forChain } from "#src/source.ts";

const abi = bridgeAbi as Abi;
const bridge = BRIDGES.base as Hex;
const token = addresses.tokens[0]!.toLowerCase() as Hex;
const otherToken = "0x00000000000000000000000000000000000000bb";
const remote = "0x00000000000000000000000000000000000000ee";
const user = "0x00000000000000000000000000000000000000aa";
const l1 = "0x00000000000000000000000000000000000000cc";

const event = (eventName: string, localToken: Hex, amount: bigint) =>
  encodeEvent({
    abi,
    eventName,
    address: bridge,
    args: eventName.startsWith("ERC20")
      ? { localToken, remoteToken: remote, from: l1, to: user, amount, extraData: "0x" }
      : { l1Token: remote, l2Token: localToken, from: l1, to: user, amount, extraData: "0x" },
  });

async function records(t: TestContext) {
  const logs = [
    event("ERC20BridgeFinalized", token, 1n), // kept
    event("ERC20BridgeFinalized", otherToken, 2n), // another Base token
    event("ERC20BridgeInitiated", token, 3n), // kept
    event("DepositFinalized", token, 4n), // the legacy twin of a finalized deposit: never read
  ];
  const mock = await mockPortal({ blocks: logs.map((log, i) => mockBlock({ number: i + 1, transactions: [{ logs: [log] }] })) });
  t.after(() => mock.close());
  const stream = await forChain("base").stream({ PORTAL_URL: mock.url, START_BLOCK: 1 });
  const read: RawRecord[] = [];
  for await (const { data } of stream) read.push(...(Array.isArray(data) ? data : Object.values(data).flat()));
  return read.sort((a, b) => Number(a.data.block_number) - Number(b.data.block_number));
}

test("the two ERC20Bridge events of the listed tokens become records; other tokens and legacy twins do not", async (t) => {
  const read = await records(t);
  assert.deepEqual(read.map((r) => [r.data.block_number, r.data.event]), [
    [1, "ERC20BridgeFinalized"],
    [3, "ERC20BridgeInitiated"],
  ]);
  assert.deepEqual(read[0]!.data.args, { localToken: token, remoteToken: remote, from: l1, to: user, amount: 1n, extraData: "0x" });
});

test("a chain with no bridge in BRIDGES is refused, and the error says where to add it", () => {
  assert.throws(() => forChain("ethereum"), /No OP Standard Bridge on ethereum: add its L2StandardBridge to BRIDGES/);
});
