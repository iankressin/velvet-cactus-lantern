# question.yaml

`answers/<slug>/question.yaml` says what an answer counts, over which data. `bj answer` reads it and refuses a key it does not know.

| Key | Required | What it holds |
|---|---|---|
| `question` | yes | The user's question, in their words. |
| `asked` | no | The date the user asked, `YYYY-MM-DD`. Resolve "last month" or "now" against it. |
| `definitions` | no | Each word that could be counted two ways, mapped to the reading you used. |
| `alternatives` | no | Readings you passed over that would change the number. |
| `window` | no | The time span: `from`, `to`, and the blocks from `bj blocks`. On one chain, `chain` plus `blocks: [from, to]`. On several chains, `blocks` maps each chain to its range, `{arbitrum: [from, to], base: [from, to]}`. Use `at: latest` for a question about now. History inputs need blocks on their chain. |
| `inputs` | no | One entry per kind of data: `name`, `strategy` (`state` or `history`), and the `mart` that holds it. A history input names its `source` as `<chain>.<table>`, and may narrow it with `filter`, keyed like the source's `addresses.json`, with every address quoted. `bj answer` checks coverage for it. |
| `marts` | no | The marts the analyses read. |
| `analyses` | no | The dbt analyses to run, headline first. Defaults to the slug with `_` for `-`. |

A question about now, answered from an existing mart:

```yaml
question: How much ETH do the tracked wallets hold right now?
asked: 2026-11-04
definitions:
  tracked wallets: The wallets in ingestion/sources/evm-eth-balances/chains/ethereum/addresses.json
  right now: Each wallet's latest balance reading
window:
  chain: ethereum
  at: latest
inputs:
  - name: eth_balances
    strategy: state
    mart: latest_balances
marts: [latest_balances]
analyses: [tracked_wallets_eth, tracked_wallets_eth_by_wallet]
```

A question over a past month that needs history, which `bj` cannot load yet:

```yaml
question: How many wallets bought PEPE on Ethereum last month?
asked: 2026-11-04
definitions:
  bought: Sent a DEX swap whose output token is PEPE
  wallet: The address that signed the swap transaction
alternatives:
  - Count swap recipients, not senders
  - Count every wallet that received PEPE, swap or not
window:
  chain: ethereum
  from: 2026-10-01
  to: 2026-11-01
  blocks: [26093738, 26316188]
inputs:
  - name: pepe_pools
    strategy: history
    protocol: uniswap
    events: [v2.PairCreated, v3.PoolCreated]
    filter: {token: PEPE}
    blocks: from_deployment
  - name: pepe_swaps
    strategy: history
    protocol: uniswap
    events: [v2.Swap, v3.Swap]
    filter: {contracts: pepe_pools}
    blocks: window
marts: [dex_trades]
```
