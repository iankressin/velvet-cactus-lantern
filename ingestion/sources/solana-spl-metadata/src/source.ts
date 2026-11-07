import { readJson, type Source } from "@ingestion/lib";
import {
  createSolanaClient,
  solanaEnv,
  validateSolanaAddressList,
  type SolanaEnv,
} from "@ingestion/lib/solana";
import {
  readWalletAssets,
  walletAssetsEnv,
  type WalletAssetsEnv,
} from "@ingestion/lib/wallet-assets";
import {
  fetchMetadata,
  metadataCallSchema,
  metadataCalls,
  type MetadataCall,
} from "#src/metadata.ts";

// The decimals, names and symbols of every mint in the wallet asset CSV's solana spl rows and
// in addresses.json, plus the calls that failed in earlier runs, at the latest finalized slot.
// A mint in both lists, or in many rows, is read once.
export const solanaSplMetadata: Source<SolanaEnv & WalletAssetsEnv, MetadataCall> = {
  name: "solana",
  table: "spl_metadata",
  env: solanaEnv.extend(walletAssetsEnv.shape),
  call: metadataCallSchema,
  async *extract(env, retry) {
    // Read inside the run, not at import, so runSource reports a bad file.
    const mints = [
      ...readWalletAssets(env.WALLET_ASSETS_CSV, "solana", "spl").map(({ tokenAddress }) => tokenAddress),
      ...validateSolanaAddressList(readJson("addresses.json").mints),
    ];
    // solana-spl-balances reads through the same free upstreams at the same hour, and they
    // allow only a few calls a second.
    const rpc = createSolanaClient(env.SOLANA_RPC_URL, { maxConcurrency: 2 });
    yield await fetchMetadata(rpc, [...metadataCalls(mints), ...retry]);
  },
};
