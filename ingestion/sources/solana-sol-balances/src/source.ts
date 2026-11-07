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

// SOL balance of every wallet in addresses.json, plus the wallets that failed in earlier runs,
// at the latest finalized slot.
export const solanaSolBalances: Source<SolanaEnv, BalanceCall> = {
  name: "solana",
  table: "sol_balances",
  env: solanaEnv,
  call: balanceCallSchema,
  async *extract(env, retry) {
    // Read inside the run, not at import, so runSource reports a bad addresses.json.
    const addresses = readJson("addresses.json");
    const wallets = validateSolanaAddressList(addresses.wallets);
    const rpc = createSolanaClient(env.SOLANA_RPC_URL);
    yield await fetchBalances(rpc, [...balanceCalls(wallets), ...retry]);
  },
};
