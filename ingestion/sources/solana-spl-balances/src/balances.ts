import { settleCalls } from "@ingestion/lib";
import { solanaAddress, type SolanaClient } from "@ingestion/lib/solana";
import { address, type Address } from "@solana/kit";
import * as z from "zod";

export const balanceCallSchema = z.object({
  kind: z.literal("spl_balance"),
  mint: solanaAddress,
  wallet: solanaAddress,
});

export type BalanceCall = z.infer<typeof balanceCallSchema>;

/** One call per listed wallet and mint. A wallet asks only for the mints listed with it. */
export const balanceCalls = (
  assets: readonly { walletAddress: Address; tokenAddress: Address }[],
): BalanceCall[] =>
  assets.map(({ walletAddress, tokenAddress }) => ({
    kind: "spl_balance",
    mint: tokenAddress,
    wallet: walletAddress,
  }));

// No slot: a Solana RPC cannot read a past slot, so a call is known by what it asks for,
// and a retried call reads the balance as it is now. The record id adds the slot.
const callId = (call: BalanceCall) => `${call.mint}:${call.wallet}`;

export const TOKEN_PROGRAMS = [
  address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
];

type WalletBalances = { slot: bigint; byMint: Map<string, bigint> };

/** Every token account a wallet holds, under both token programs, summed by mint: a wallet can
 * hold one mint in several token accounts. The slot is the later of the two reads. */
async function walletBalances(rpc: SolanaClient, wallet: Address): Promise<WalletBalances> {
  const replies = await Promise.all(
    TOKEN_PROGRAMS.map((programId) =>
      rpc
        .getTokenAccountsByOwner(
          wallet,
          { programId },
          { commitment: "finalized", encoding: "jsonParsed" },
        )
        .send(),
    ),
  );
  const byMint = new Map<string, bigint>();
  for (const { value } of replies) {
    for (const { account } of value) {
      const { mint, tokenAmount } = account.data.parsed.info;
      byMint.set(mint, (byMint.get(mint) ?? 0n) + BigInt(tokenAmount.amount));
    }
  }
  const slot = replies.reduce((max, { context }) => (context.slot > max ? context.slot : max), 0n);
  return { slot, byMint };
}

/** Two getTokenAccountsByOwner calls per wallet, one per token program, however many of its
 * mints are listed: the free RPCs allow only a few such calls a minute. When a wallet's read
 * fails, each of its calls fails and waits as a dead letter. */
export const fetchBalances = (rpc: SolanaClient, calls: readonly BalanceCall[]) => {
  const reads = new Map<string, Promise<WalletBalances>>();
  const read = (wallet: Address) => {
    let pending = reads.get(wallet);
    if (!pending) reads.set(wallet, (pending = walletBalances(rpc, wallet)));
    return pending;
  };
  return settleCalls(
    calls,
    callId,
    async (call) => {
      const { slot, byMint } = await read(call.wallet);
      return { slot, mint: call.mint, wallet: call.wallet, balance: byMint.get(call.mint) ?? 0n };
    },
    (call, { slot }) => `${slot}:${callId(call)}`,
  );
};
