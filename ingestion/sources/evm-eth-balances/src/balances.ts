import { settleCalls } from "@ingestion/lib";
import { address, toLower, type EvmClient } from "@ingestion/lib/evm";
import type { Address } from "viem";
import * as z from "zod";

export const balanceCallSchema = z.object({
  kind: z.literal("eth_balance"),
  block: z.number().int().nonnegative(),
  wallet: address,
});

export type BalanceCall = z.infer<typeof balanceCallSchema>;

export const balanceCallsAt = (
  block: number,
  wallets: readonly Address[],
): BalanceCall[] =>
  wallets.map((wallet) => ({
    kind: "eth_balance",
    block,
    wallet: toLower(wallet),
  }));

const callId = (call: BalanceCall) => `${call.block}:${call.wallet}`;

export const fetchBalances = (client: EvmClient, calls: readonly BalanceCall[]) =>
  settleCalls(calls, callId, async (call) => ({
    block_number: call.block,
    wallet: call.wallet,
    balance: await client.getBalance({
      address: call.wallet,
      blockNumber: BigInt(call.block),
    }),
  }));
