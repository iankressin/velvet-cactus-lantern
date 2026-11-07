import { readJson, settleCalls, type Source } from "@ingestion/lib";
import {
  address,
  connect,
  evmEnv,
  toLower,
  validateEthAddressList,
  type EvmClient,
  type EvmEnv,
} from "@ingestion/lib/evm";
import {
  BaseError,
  RawContractError,
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  erc20Abi_bytes32,
  hexToString,
  type Address,
  type Hex,
} from "viem";
import * as z from "zod";

/** A chain name as SOURCES and the dbt sources spell it, such as `ethereum`. */
export const chainName = z.string().regex(/^[a-z][a-z0-9]*$/, "Expected a chain name such as ethereum");

export const metadataCallSchema = z.object({
  kind: z.literal("erc20_metadata"),
  block: z.number().int().nonnegative(),
  token: address,
});

export type MetadataCall = z.infer<typeof metadataCallSchema>;

const callId = (call: MetadataCall) => `${call.block}:${call.token}`;

export const metadataCallsAt = (block: number, tokens: readonly Address[]): MetadataCall[] =>
  tokens.map((token) => ({ kind: "erc20_metadata", block, token: toLower(token) }));

// A revert at a pinned block gives the same answer on every retry, so it is a fact to record, not a
// failure to queue. viem raises RawContractError only for one call's own result inside a Multicall3
// batch, never for a failed batch request.
const revertedAtBlock = (error: unknown) =>
  error instanceof BaseError && error.walk((e) => e instanceof RawContractError) !== null;

/**
 * What the token's `functionName()` returns at the call's block, undecoded, or null if it reverts or
 * returns nothing: ERC-20 makes all three functions optional. Throws on errors a retry may fix.
 */
async function replyAt(
  client: EvmClient,
  call: MetadataCall,
  functionName: "name" | "symbol" | "decimals",
): Promise<Hex | null> {
  try {
    const { data } = await client.call({
      to: call.token,
      data: encodeFunctionData({ abi: erc20Abi, functionName }),
      blockNumber: BigInt(call.block),
    });
    return data ?? null;
  } catch (error) {
    if (revertedAtBlock(error)) return null;

    throw error;
  }
}

/**
 * A name or symbol reply as text. Some old tokens, such as MKR, return a bytes32 instead of an ABI
 * string. Every zero byte is dropped: bytes32 pads with them, and Postgres rejects them in jsonb,
 * which would fail the whole batch.
 */
function text(functionName: "name" | "symbol", data: Hex | null): string | null {
  if (data === null) return null;
  let value: string;
  try {
    value = decodeFunctionResult({ abi: erc20Abi, functionName, data });
  } catch (error) {
    if (data.length !== 66) throw error;
    value = hexToString(decodeFunctionResult({ abi: erc20Abi_bytes32, functionName, data }));
  }
  return value.replaceAll("\u0000", "") || null;
}

/**
 * Each token's name, symbol and decimals at the call's block. The client sends every read at the
 * same block as one Multicall3 call (see createEvmClient), because they all start in one tick.
 */
export const fetchMetadata = (client: EvmClient, calls: readonly MetadataCall[]) =>
  settleCalls(calls, callId, async (call) => {
    const [name, symbol, decimals] = await Promise.all([
      replyAt(client, call, "name"),
      replyAt(client, call, "symbol"),
      replyAt(client, call, "decimals"),
    ]);
    return {
      block_number: call.block,
      token: call.token,
      name: text("name", name),
      symbol: text("symbol", symbol),
      decimals:
        decimals === null ? null : decodeFunctionResult({ abi: erc20Abi, functionName: "decimals", data: decimals }),
    };
  });

/**
 * The name, symbol and decimals of every token in chains/<chain>/addresses.json at BLOCK_NUMBER, plus
 * the calls that failed in earlier runs, at their own blocks. The source is named for its chain, so
 * each chain loads into raw.<chain>_erc20_metadata.
 */
export const forChain = (chain: string): Source<EvmEnv, MetadataCall> => ({
  name: chainName.parse(chain),
  table: "erc20_metadata",
  env: evmEnv,
  call: metadataCallSchema,
  async *extract(env, retry) {
    // Read inside the run, not at import, so runSource reports a bad addresses.json.
    const list = readJson(`chains/${chain}/addresses.json`);
    const tokens = validateEthAddressList(list.tokens);
    const { client, block } = await connect(env);
    yield await fetchMetadata(client, [...metadataCallsAt(block, tokens), ...retry]);
  },
});
