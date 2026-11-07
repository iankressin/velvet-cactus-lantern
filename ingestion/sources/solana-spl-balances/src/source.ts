import { readJson, type Source } from "@ingestion/lib";
import {
  createSolanaClient,
  solanaEnv,
  validateSolanaAddressList,
  type SolanaEnv,
} from "@ingestion/lib/solana";
import {
  balanceCallSchema,
  balanceCalls,
  fetchBalances,
  type BalanceCall,
} from "#src/balances.ts";

// Balance of every mint for every wallet in addresses.json, plus the calls that failed in
// earlier runs, at the latest finalized slot.
export const solanaSplBalances: Source<SolanaEnv, BalanceCall> = {
  name: "solana",
  table: "spl_balances",
  env: solanaEnv,
  call: balanceCallSchema,
  async *extract(env, retry) {
    // Read inside the run, not at import, so runSource reports a bad addresses.json.
    const addresses = readJson("addresses.json");
    const wallets = validateSolanaAddressList(addresses.wallets);
    const mints = validateSolanaAddressList(addresses.mints);
    // The free RPCs that serve getTokenAccountsByOwner allow about 2 calls a second
    // between them; sent all at once, most calls are refused.
    const rpc = createSolanaClient(env.SOLANA_RPC_URL, { maxConcurrency: 2 });
    yield await fetchBalances(rpc, [...balanceCalls(wallets, mints), ...retry]);
  },
};
