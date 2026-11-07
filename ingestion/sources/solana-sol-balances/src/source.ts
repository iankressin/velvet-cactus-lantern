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

// SOL balance of every wallet in the wallet asset CSV's solana native rows, plus the wallets
// that failed in earlier runs, at the latest finalized slot.
export const solanaSolBalances: Source<SolanaEnv & WalletAssetsEnv, BalanceCall> = {
  name: "solana",
  table: "sol_balances",
  env: solanaEnv.extend(walletAssetsEnv.shape),
  call: balanceCallSchema,
  async *extract(env, retry) {
    // Read inside the run, not at import, so runSource reports a bad file.
    const assets = readWalletAssets(env.WALLET_ASSETS_CSV, "solana", "native");
    const rpc = createSolanaClient(env.SOLANA_RPC_URL);
    yield await fetchBalances(rpc, [
      ...balanceCalls(assets.map((asset) => asset.walletAddress)),
      ...retry,
    ]);
  },
};
