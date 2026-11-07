import { chunk, describeError, uniqueBy, type Batch } from "@ingestion/lib";
import { solanaAddress, type SolanaClient } from "@ingestion/lib/solana";
import type { Address } from "@solana/kit";
import * as z from "zod";

export const balanceCallSchema = z.object({
  kind: z.literal("sol_balance"),
  wallet: solanaAddress,
});

export type BalanceCall = z.infer<typeof balanceCallSchema>;

export const balanceCalls = (wallets: readonly Address[]): BalanceCall[] =>
  wallets.map((wallet) => ({ kind: "sol_balance", wallet }));

// The most addresses one getMultipleAccounts call accepts.
const ACCOUNTS_PER_CALL = 100;

/**
 * One getMultipleAccounts call per 100 wallets, so each group is read at one slot.
 * A call is known by its wallet alone, since a Solana RPC cannot read a past slot and a
 * retried call reads the balance as it is now. The record id adds the slot it was read
 * at, so each run keeps its own reading.
 */
export async function fetchBalances(
  rpc: SolanaClient,
  calls: readonly BalanceCall[],
): Promise<Batch<BalanceCall>> {
  const groups = chunk(
    uniqueBy(calls, (call) => call.wallet),
    ACCOUNTS_PER_CALL,
  );
  const outcomes = await Promise.allSettled(
    groups.map((group) =>
      rpc
        .getMultipleAccounts(
          group.map((call) => call.wallet),
          {
            commitment: "finalized",
            encoding: "base64",
            dataSlice: { offset: 0, length: 0 },
          },
        )
        .send(),
    ),
  );

  const batch: Batch<BalanceCall> = { records: [], failed: [] };

  groups.forEach((group, i) => {
    const outcome = outcomes[i]!;

    group.forEach((call, j) => {
      if (outcome.status === "fulfilled")
        batch.records.push({
          id: `${outcome.value.context.slot}:${call.wallet}`,
          callId: call.wallet,
          data: {
            slot: outcome.value.context.slot,
            wallet: call.wallet,
            // An address that never held SOL has no account.
            balance: outcome.value.value[j]?.lamports ?? 0n,
          },
        });
      else
        batch.failed.push({
          id: call.wallet,
          call,
          error: describeError(outcome.reason),
        });
    });
  });

  return batch;
}
