import { settleCalls } from "@ingestion/lib";
import { solanaAddress, type SolanaClient } from "@ingestion/lib/solana";
import type { Address } from "@solana/kit";
import * as z from "zod";

export const balanceCallSchema = z.object({
  kind: z.literal("spl_balance"),
  mint: solanaAddress,
  wallet: solanaAddress,
});

export type BalanceCall = z.infer<typeof balanceCallSchema>;

export const balanceCalls = (
  wallets: readonly Address[],
  mints: readonly Address[],
): BalanceCall[] =>
  mints.flatMap((mint) =>
    wallets.map((wallet) => ({ kind: "spl_balance", mint, wallet })),
  );

// No slot: a Solana RPC cannot read a past slot, so a call is known by what it asks for,
// and a retried call reads the balance as it is now. The record id adds the slot.
const callId = (call: BalanceCall) => `${call.mint}:${call.wallet}`;

/** A wallet can hold one mint in several token accounts, so its balance is their sum. */
async function balanceOf(rpc: SolanaClient, call: BalanceCall) {
  const { context, value } = await rpc
    .getTokenAccountsByOwner(
      call.wallet,
      { mint: call.mint },
      { commitment: "finalized", encoding: "jsonParsed" },
    )
    .send();

  return {
    slot: context.slot,
    balance: value.reduce(
      (sum, { account }) =>
        sum + BigInt(account.data.parsed.info.tokenAmount.amount),
      0n,
    ),
  };
}

/** One getTokenAccountsByOwner call per wallet and mint. Covers both the Token and Token-2022 programs. */
export const fetchBalances = (rpc: SolanaClient, calls: readonly BalanceCall[]) =>
  settleCalls(
    calls,
    callId,
    async (call) => {
      const { slot, balance } = await balanceOf(rpc, call);
      return { slot, mint: call.mint, wallet: call.wallet, balance };
    },
    (call, { slot }) => `${slot}:${callId(call)}`,
  );
