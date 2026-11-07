import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { RawRecord } from "@ingestion/lib";
import { mockPortal } from "@subsquid/pipes/testing";
import { encodeEvent, mockBlock } from "@subsquid/pipes/testing/evm";
import type { Abi, Hex } from "viem";
import gatewayAbi from "../../../../catalog/protocols/arbitrum-token-bridge/abis/l2-gateway.json" with { type: "json" };
import addresses from "../addresses.json" with { type: "json" };
import { source } from "#src/source.ts";

const abi = gatewayAbi as Abi;
const token = addresses.tokens[0]!.toLowerCase() as Hex;
const other = "0x00000000000000000000000000000000000000bb";
const user = "0x00000000000000000000000000000000000000aa";
const l1 = "0x00000000000000000000000000000000000000cc";
const gateway = "0x00000000000000000000000000000000000000dd";
const ownGateway = "0x00000000000000000000000000000000000000ee";

const deposit = (address: Hex, l1Token: Hex, amount: bigint) =>
  encodeEvent({ abi, eventName: "DepositFinalized", address, args: { l1Token, _from: l1, _to: user, _amount: amount } as never });
const withdrawal = (address: Hex, l1Token: Hex, amount: bigint) =>
  encodeEvent({
    abi,
    eventName: "WithdrawalInitiated",
    address,
    // The catalog ABI is JSON, so viem cannot type an event's args.
    args: { l1Token, _from: user, _to: l1, _l2ToL1Id: 7n, _exitNum: 1n, _amount: amount } as never,
  });

async function records(t: TestContext) {
  const logs = [
    deposit(gateway, token, 1n),
    deposit(ownGateway, token, 2n),
    deposit(gateway, other, 3n),
    withdrawal(gateway, other, 4n),
    withdrawal(ownGateway, token, 5n),
  ];
  const mock = await mockPortal({ blocks: logs.map((log, i) => mockBlock({ number: i + 1, transactions: [{ logs: [log] }] })) });
  t.after(() => mock.close());
  const stream = await source.stream({ PORTAL_URL: mock.url, START_BLOCK: 1 });
  const read: RawRecord[] = [];
  for await (const { data } of stream) read.push(...(Array.isArray(data) ? data : Object.values(data).flat()));
  return read.sort((a, b) => Number(a.data.block_number) - Number(b.data.block_number));
}

test("deposits of the listed tokens and every withdrawal become records, from any contract", async (t) => {
  const read = await records(t);
  assert.deepEqual(read.map((r) => [r.data.block_number, r.data.event, r.data.contract]), [
    [1, "DepositFinalized", gateway],
    [2, "DepositFinalized", ownGateway],
    [4, "WithdrawalInitiated", gateway],
    [5, "WithdrawalInitiated", ownGateway],
  ], "block 3, a deposit of a token not in addresses.json, is left out");
  const [first] = read;
  assert.match(first!.id, /^1:\d+$/, "a record's id is its block and log index");
  assert.deepEqual(first!.data.args, { l1Token: token, _from: l1, _to: user, _amount: 1n });
});
