import { describeError, uniqueBy, type Batch } from "@ingestion/lib";
import {
  bitcoinAddress,
  scriptPubKey,
  type BitcoinAddress,
  type BitcoinClient,
} from "@ingestion/lib/bitcoin";
import * as z from "zod";

export const balanceCallSchema = z.object({
  kind: z.literal("btc_balance"),
  wallet: bitcoinAddress,
});

export type BalanceCall = z.infer<typeof balanceCallSchema>;

export const balanceCalls = (wallets: readonly BitcoinAddress[]): BalanceCall[] =>
  wallets.map((wallet) => ({ kind: "btc_balance", wallet }));

/**
 * One scantxoutset call for every wallet, since the node scans the whole UTXO set once however
 * many wallets it looks for. A call is known by its wallet alone, since a node reads only the
 * current UTXO set and a retried call reads the balance as it is now. The record id adds the
 * height the scan read, so each run keeps its own reading.
 */
export async function fetchBalances(
  client: BitcoinClient,
  calls: readonly BalanceCall[],
): Promise<Batch<BalanceCall>> {
  const unique = uniqueBy(calls, (call) => call.wallet);
  try {
    const { height, balances } = await readBalances(client, unique.map((call) => call.wallet));
    return {
      records: [...balances].map(([wallet, balance]) => ({
        id: `${height}:${wallet}`,
        callId: wallet,
        data: { block_number: height, wallet, balance },
      })),
      failed: [],
    };
  } catch (error) {
    return {
      records: [],
      failed: unique.map((call) => ({ id: call.wallet, call, error: describeError(error) })),
    };
  }
}

/** Each wallet's balance in satoshis, at the height the scan read. A wallet with no unspents has 0. */
async function readBalances(client: BitcoinClient, wallets: readonly BitcoinAddress[]) {
  const { height, unspents } = await client.scanTxOutSet(wallets.map((wallet) => `addr(${wallet})`));

  // Matched by script, not by each unspent's desc: the node infers that from the script, so a
  // taproot output comes back as rawtr(...), not addr(bc1p...).
  const owners = new Map(wallets.map((wallet) => [scriptPubKey(wallet), wallet]));
  const balances = new Map(wallets.map((wallet) => [wallet, 0n]));
  for (const unspent of unspents) {
    const wallet = owners.get(unspent.scriptPubKey);
    // The node returns only outputs that pay a wallet it was asked for, so a miss means this
    // code derived a script the node did not, and some wallet's balance would come out short.
    if (wallet === undefined)
      throw new Error(`scantxoutset: an unspent pays ${unspent.scriptPubKey}, which no wallet's script matches`);
    // Exact: an amount has at most 8 decimals and no output holds more than 2.1e15 satoshis,
    // under 2^53, so the float lands within half a satoshi of the true count.
    balances.set(wallet, balances.get(wallet)! + BigInt(Math.round(unspent.amount * 1e8)));
  }
  return { height, balances };
}
