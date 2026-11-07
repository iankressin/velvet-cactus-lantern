import type { Source } from "@ingestion/lib";
import { createSolanaClient, solanaEnv, type SolanaEnv } from "@ingestion/lib/solana";
import {
  readWalletAssets,
  walletAssetsEnv,
  type WalletAssetsEnv,
} from "@ingestion/lib/wallet-assets";
import {
  balanceCallSchema,
  balanceCalls,
  fetchBalances,
  type BalanceCall,
} from "#src/balances.ts";

// Balance of each wallet and mint in the wallet asset CSV's solana spl rows, plus the calls
// that failed in earlier runs, at the latest finalized slot.
export const solanaSplBalances: Source<SolanaEnv & WalletAssetsEnv, BalanceCall> = {
  name: "solana",
  table: "spl_balances",
  env: solanaEnv.extend(walletAssetsEnv.shape),
  call: balanceCallSchema,
  async *extract(env, retry) {
    // Read inside the run, not at import, so runSource reports a bad file.
    const assets = readWalletAssets(env.WALLET_ASSETS_CSV, "solana", "spl");
    // The free RPCs that serve getTokenAccountsByOwner allow about 2 calls a second
    // between them; sent all at once, most calls are refused.
    const rpc = createSolanaClient(env.SOLANA_RPC_URL, { maxConcurrency: 2 });
    yield await fetchBalances(rpc, [...balanceCalls(assets), ...retry]);
  },
};
