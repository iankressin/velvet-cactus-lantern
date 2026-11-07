import { readJson, type Source } from "@ingestion/lib";
import {
  bitcoinEnv,
  createBitcoinClient,
  validateBitcoinAddressList,
  type BitcoinEnv,
} from "@ingestion/lib/bitcoin";
import {
  balanceCallSchema,
  balanceCalls,
  fetchBalances,
  type BalanceCall,
} from "#src/balances.ts";

// BTC balance of every wallet in addresses.json, plus the wallets that failed in earlier runs,
// at the chain tip.
export const bitcoinBtcBalances: Source<BitcoinEnv, BalanceCall> = {
  name: "bitcoin",
  table: "btc_balances",
  env: bitcoinEnv,
  call: balanceCallSchema,
  async *extract(env, retry) {
    // Read inside the run, not at import, so runSource reports a bad addresses.json.
    const addresses = readJson("addresses.json");
    const wallets = validateBitcoinAddressList(addresses.wallets);
    const client = createBitcoinClient(env.DSHACKLE_URL);
    yield await fetchBalances(client, [...balanceCalls(wallets), ...retry]);
  },
};
