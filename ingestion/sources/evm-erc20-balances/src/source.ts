import type { Source } from "@ingestion/lib";
import { connect, evmEnv, type EvmEnv } from "@ingestion/lib/evm";
import { evmBlockchain, readWalletAssets, walletAssetsEnv, type WalletAssetsEnv } from "@ingestion/lib/wallet-assets";
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
 * The balance of each wallet and token in the chain's erc20 rows of the wallet asset CSV at
 * BLOCK_NUMBER, plus the calls that failed in earlier runs, at their own blocks. The source is named
 * for its chain, so each chain loads into raw.<chain>_erc20_balances.
 */
export const forChain = (chain: string): Source<EvmEnv & WalletAssetsEnv, BalanceCall> => ({
  name: chainName.parse(chain),
  table: "erc20_balances",
  env: evmEnv.extend(walletAssetsEnv.shape),
  call: balanceCallSchema,
  async *extract(env, retry) {
    // Read inside the run, not at import, so runSource reports a bad file, or a chain the CSV cannot
    // hold yet. generate-sources-json still builds a Source for every chain in chains/.
    const assets = readWalletAssets(env.WALLET_ASSETS_CSV, evmBlockchain.parse(chain), "erc20");
    const { client, block } = await connect(env);
    yield await fetchBalances(client, [...balanceCallsAt(block, assets), ...retry]);
  },
});
