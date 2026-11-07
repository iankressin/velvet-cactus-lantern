import { randomUUID } from "node:crypto";
import type { Source } from "@ingestion/lib";
import { readWalletAssetLines, walletAssetsEnv, type WalletAssetsEnv } from "@ingestion/lib/wallet-assets";
import * as z from "zod";

// Every line of the wallet asset CSV, bad ones and repeats too, under a new load id on each run. The
// balances CSV takes the newest load as the list of what to report, so it can report on each line.
export const inputWalletAssets: Source<WalletAssetsEnv, never> = {
  name: "input",
  table: "wallet_assets",
  env: walletAssetsEnv,
  call: z.never(),
  async *extract(env) {
    // Read inside the run, not at import, so runSource reports a bad file.
    const lines = readWalletAssetLines(env.WALLET_ASSETS_CSV);
    const loadId = randomUUID();
    const records = lines.map(({ line, blockchain, walletAddress, tokenAddress, asset, problems }) => {
      const id = `${loadId}:${line}`;
      const data = {
        load_id: loadId,
        line,
        blockchain,
        wallet_address: walletAddress,
        token_address: tokenAddress,
        asset_type: asset?.assetType ?? null,
        wallet: asset?.walletAddress ?? null,
        token: asset?.tokenAddress ?? null,
        problem: problems.length > 0 ? problems.join("; ") : null,
      };
      return { id, callId: id, data };
    });
    yield { records, failed: [] };
  },
};
