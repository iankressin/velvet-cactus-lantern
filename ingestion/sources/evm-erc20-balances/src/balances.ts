import {
  BaseError,
  ContractFunctionZeroDataError,
  RawContractError,
  erc20Abi,
  type Address,
} from "viem";
import * as z from "zod";
import { settleCalls } from "@ingestion/lib";
import { address, toLower, type EvmClient } from "@ingestion/lib/evm";

export const balanceCallSchema = z.object({
  kind: z.literal("erc20_balance"),
  block: z.number().int().nonnegative(),
  token: address,
  wallet: address,
});

export type BalanceCall = z.infer<typeof balanceCallSchema>;

export const balanceCallsAt = (
  block: number,
  wallets: readonly Address[],
  tokens: readonly Address[],
): BalanceCall[] =>
  tokens.flatMap((token) =>
    wallets.map((wallet) => ({
      kind: "erc20_balance",
      block,
      token: toLower(token),
      wallet: toLower(wallet),
    })),
  );

const callId = (call: BalanceCall) =>
  `${call.block}:${call.token}:${call.wallet}`;

// A revert or an empty reply at a pinned block (e.g. the token was not deployed yet) gives the
// same answer on every retry, so it is a fact to record, not a failure to queue.
// viem raises these two errors only for one call's own result inside a Multicall3 batch. Its
// ContractFunctionRevertedError and AbiDecodingZeroDataError also cover a failed batch request.
const revertedAtBlock = (error: unknown) =>
  error instanceof BaseError &&
  error.walk(
    (e) =>
      e instanceof RawContractError ||
      e instanceof ContractFunctionZeroDataError,
  ) !== null;

/** The balance at the call's block, or null if balanceOf reverts there. Throws on errors a retry may fix. */
async function balanceAt(
  client: EvmClient,
  call: BalanceCall,
): Promise<bigint | null> {
  try {
    return await client.readContract({
      address: call.token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [call.wallet],
      blockNumber: BigInt(call.block),
    });
  } catch (error) {
    if (revertedAtBlock(error)) return null;

    throw error;
  }
}

/** The client merges calls at the same block into one Multicall3 call (see createEvmClient). */
export const fetchBalances = (client: EvmClient, calls: readonly BalanceCall[]) =>
  settleCalls(calls, callId, async (call) => ({
    block_number: call.block,
    token: call.token,
    wallet: call.wallet,
    balance: await balanceAt(client, call),
  }));
