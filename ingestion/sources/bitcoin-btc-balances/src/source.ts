import type { Source } from "@ingestion/lib";
import { bitcoinEnv, createBitcoinClient, type BitcoinEnv } from "@ingestion/lib/bitcoin";
import { readWalletAssets, walletAssetsEnv, type WalletAssetsEnv } from "@ingestion/lib/wallet-assets";
import {
  balanceCallSchema,
  balanceCalls,
  fetchBalances,
  type BalanceCall,
} from "#src/balances.ts";

// BTC balance of every wallet in the Bitcoin rows of the wallet asset CSV, plus the wallets that
// failed in earlier runs, at the chain tip.
export const bitcoinBtcBalances: Source<BitcoinEnv & WalletAssetsEnv, BalanceCall> = {
  name: "bitcoin",
  table: "btc_balances",
  env: bitcoinEnv.extend(walletAssetsEnv.shape),
  call: balanceCallSchema,
  async *extract(env, retry) {
    // Read inside the run, not at import, so runSource reports a bad file.
    const wallets = readWalletAssets(env.WALLET_ASSETS_CSV, "bitcoin").map((asset) => asset.walletAddress);
    const client = createBitcoinClient(env.DSHACKLE_URL);
    yield await fetchBalances(client, [...balanceCalls(wallets), ...retry]);
  },
};
