import { readJson, type Source } from "@ingestion/lib";
import { connect, evmEnv, validateEthAddressList, type EvmEnv } from "@ingestion/lib/evm";
import * as z from "zod";
import {
  balanceCallSchema,
  balanceCallsAt,
  fetchBalances,
  type BalanceCall,
} from "#src/balances.ts";

/** A chain name as SOURCES and the dbt sources spell it, such as `ethereum`. */
export const chainName = z.string().regex(/^[a-z][a-z0-9]*$/, "Expected a chain name such as ethereum");

/**
 * The native balance of every wallet in chains/<chain>/addresses.json at BLOCK_NUMBER, plus the calls
 * that failed in earlier runs, at their own blocks. The source is named for its chain, so each chain
 * loads into raw.<chain>_eth_balances.
 */
export const forChain = (chain: string): Source<EvmEnv, BalanceCall> => ({
  name: chainName.parse(chain),
  table: "eth_balances",
  env: evmEnv,
  call: balanceCallSchema,
  async *extract(env, retry) {
    // Read inside the run, not at import, so runSource reports a bad addresses.json.
    const addresses = readJson(`chains/${chain}/addresses.json`);
    const wallets = validateEthAddressList(addresses.wallets);
    const { client, block } = await connect(env);
    yield await fetchBalances(client, [...balanceCallsAt(block, wallets), ...retry]);
  },
});
