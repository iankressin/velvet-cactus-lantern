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
import type { Address } from "viem";
import * as z from "zod";

/** A chain name as SOURCES and the dbt sources spell it, such as `arbitrum`. */
export const chainName = z.string().regex(/^[a-z][a-z0-9]*$/, "Expected a chain name such as arbitrum");

export const codeCallSchema = z.object({
  kind: z.literal("code"),
  block: z.number().int().nonnegative(),
  address,
});

export type CodeCall = z.infer<typeof codeCallSchema>;

const callId = (call: CodeCall) => `${call.block}:${call.address}`;

export const codeCallsAt = (block: number, addresses: readonly Address[]): CodeCall[] =>
  addresses.map((a) => ({ kind: "code", block, address: toLower(a) }));

/** Each address's code at the call's block, as eth_getCode returns it: "0x" for an address with none. */
export const fetchCode = (client: EvmClient, calls: readonly CodeCall[]) =>
  settleCalls(calls, callId, async (call) => ({
    block_number: call.block,
    address: call.address,
    code: (await client.getCode({ address: call.address, blockNumber: BigInt(call.block) })) ?? "0x",
  }));

/**
 * The code of every address in chains/<chain>/addresses.json at BLOCK_NUMBER, plus the calls that
 * failed in earlier runs, at their own blocks. The source is named for its chain, so each chain
 * loads into raw.<chain>_address_code.
 */
export const forChain = (chain: string): Source<EvmEnv, CodeCall> => ({
  name: chainName.parse(chain),
  table: "address_code",
  env: evmEnv,
  call: codeCallSchema,
  async *extract(env, retry) {
    // Read inside the run, not at import, so runSource reports a bad addresses.json.
    const list = readJson(`chains/${chain}/addresses.json`);
    const addresses = validateEthAddressList(list.addresses);
    const { client, block } = await connect(env);
    yield await fetchCode(client, [...codeCallsAt(block, addresses), ...retry]);
  },
});
