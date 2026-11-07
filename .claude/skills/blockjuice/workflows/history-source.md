# Add or extend a history source

A history source is a Pipes stream source. It reads events over a range of blocks from SQD Portal, and each run resumes after the last block it saved. `ingestion/sources/evm-erc20-transfers/` is the pattern: on each chain in its `chains/`, every Transfer of the tokens in that chain's `addresses.json`, into or out of its wallets when it lists any, from the chain's `START_BLOCK` on.

## What a history source has loaded

```sh
uv run --project orchestration bj coverage <chain>.<table>
```

It prints `start_block`, the `cursor` (the last block saved, from Pipes' cursor table `raw._sync`), the `filter` (the source's `addresses.json`) and `covered: [start_block, cursor]`. Coverage assumes the filter has not changed since `START_BLOCK`. A factory source's coverage also assumes its pool creations loaded from `POOLS_START_BLOCK` and its pool store, `factory.sqlite`, was never lost.

## Reuse before you build

When a source already reads the right events:

- The window is inside `covered` and the addresses are in its filter: nothing to load.
- The window ends after the cursor: run its pipeline with `bj run <pipeline>` until `bj coverage` shows a cursor at or after the window's last block. Each run reads at most about a million blocks.
- The window starts before `START_BLOCK`, or the question needs addresses the filter lacks: the source must be reset. Resetting deletes the source's raw rows and its cursor, then reloads everything from the new `START_BLOCK`. Ask the user first, and show them what the reload will read. With their go, edit `addresses.json` or `START_BLOCK`, then run:

  ```sql
  delete from raw._sync where id = '<chain>_<table>';
  truncate raw.<chain>_<table>;
  ```

  For a factory source, also delete `chains/<chain>/factory.sqlite` in its package, or the reload keeps the old pools.

## A new history source

1. Find the events in the protocol's catalog entry, `catalog/protocols/<name>/`. With no entry, follow [explore-protocol.md](explore-protocol.md) first.
2. Estimate the load before you build: count the matching logs over a few thousand blocks of the window with the Portal MCP (`portal_evm_query_logs`), scale it, and call it an estimate, since a thin sample can be far off. Put it in front of the user with the definitions, per [answer.md](answer.md). Never write a script to count, and never count the whole window: the estimate exists so the user can decide on the full load.
3. Build one source per protocol version, each with its own raw table, per [../references/layers.md](../references/layers.md). A question over Uniswap v2, v3 and v4 needs three sources: `evm-uniswap-v2`, `evm-uniswap-v3` and `evm-uniswap-v4`. Copy the source closest in shape:

   | Contracts | Copy |
   |---|---|
   | Tokens, for their Transfers | Nothing: add the chain's folder to `evm-erc20-transfers`, as [docs/architecture.md](../../../../docs/architecture.md#add-a-source) describes |
   | A protocol version already loaded on another chain | Nothing: add the chain's folder to its `evm-*` package, and the chain's factory to `src/source.ts`, as [docs/architecture.md](../../../../docs/architecture.md#add-a-source) describes |
   | Known contracts, such as gateways | `arbitrum-token-bridge` |
   | Contracts a factory creates, such as pools | `evm-uniswap-v3` |
   | One contract that names its children by id, such as the v4 PoolManager | `evm-uniswap-v4` |

   ```sh
   uv run --project orchestration bj new-source ethereum pancakeswap_v3 --like evm-uniswap-v3
   ```

   That makes the package `evm-pancakeswap-v3`, with one chain folder, `chains/ethereum/`, and the raw table `raw.ethereum_pancakeswap_v3`. A factory copy changes only the constants at the top of `src/source.ts` (each chain's factory address and deploy block in `FACTORIES`, its creation event, the argument that holds the child's address, the child's event, the two ABI imports), and the events its test encodes. `bj new-source` sets `table` in `src/source.ts` and regenerates `ingestion/sources.json`. `forChain(chain)` names each source for its chain, so there is no export to rename, but the error it throws for a chain missing from `FACTORIES` still names Uniswap.

4. Edit the copied `src/source.ts`. It extracts and loads only, per [../references/layers.md](../references/layers.md): each record is one item as Portal returns it, a log with its ABI-decoded arguments, or a transaction the logs came from, keyed by its hash. Give each record a `kind`, `log` or `transaction`, and never copy a transaction's fields into a log.
   - Read `[START_BLOCK, finalizedHead(portal)]` through `portalClient`, so each run ends at Portal's finalized head and no fork reaches the warehouse. An optional `END_BLOCK` stops a check window short of the head.
   - Key a log by `<block>:<logIndex>` and a transaction by `tx:<hash>`, so a rerun or an overlap writes the same row. Write only the transactions of the logs you write: Portal returns the transactions of every log it matched, including the ones a factory filter drops.
   - One `evmEventDecoder` per filter, since Pipes refuses two filters on the same event in one decoder.
   - For contracts a factory creates, such as Uniswap pools, follow the children with Pipes' factory pattern inside the stream. Never read another source's raw table to find them. A factory source has two start blocks: `POOLS_START_BLOCK` for the creation events, at the token's first pool or the factory's deployment, and `START_BLOCK` for the children's events. Pipes keeps the children it found in `chains/<chain>/factory.sqlite`, which git ignores.
   - Put addresses in `addresses.json`, and set `START_BLOCK` in `.env.example`, both in `chains/<chain>/` for an `evm-*` package, to the window's first block or the contract's deployment block.
   - Leave out sign rules, joins, buy or sell, units and prices. They go in dbt.
5. Cast the fields in staging, one view per raw table and kind of record, per [../references/layers.md](../references/layers.md). Put each version's rules from the catalog's `NOTES.md` in that version's intermediate model, with a dbt unit test per rule built from a proof log. A mart that needs every version unions those models. Add the mart in a pipeline ([new-pipeline.md](new-pipeline.md)), with `unique` and `not_null` tests on the id.
6. When a view function returns the value the events rebuild, add a reconciliation test like `transformation/tests/erc20_transfers_match_balances.sql`. It reads what the source has loaded from `var('coverage')`, which `bj answer` passes, and compares the rebuilt value with state readings inside the loaded blocks.
7. Check it on a short window first, in schemas of its own so no check cursor lands in `raw`. In the package's `.env`, set `RAW_SCHEMA` to a check schema such as `raw_dex_check`. Set `START_BLOCK` and `END_BLOCK` a few thousand blocks apart, in `chains/<chain>/.env` for an `evm-*` package: the chain's settings load first and win over the package's `.env`. Run it, then build its models with the check schemas set in the shell:

   ```sh
   set -a && . ./.env && set +a && cd transformation && RAW_SCHEMA=raw_dex_check DBT_SCHEMA=analytics_dex_check uv run --project ../orchestration dbt build --select +path:models/marts/<pipeline>
   ```

   Compare the rows with a Portal MCP count of the same blocks and filter.
   - A factory source cannot find old children quickly: its creation scan reads every block from `POOLS_START_BLOCK`, which for a token from 2023 takes over a day. Check discovery on a short range around one known creation from the catalog's proof table, check the children's events for the pools the run found, and say what the check does not prove.
   - Tell the user how long the full creation scan will take before starting it.
   - Then put the real schemas and `START_BLOCK` back, load with `bj run <pipeline>`, and check `bj coverage`.

## Use it in an answer

In `question.yaml`, name the source on its input, quote every address, and give the window in blocks:

```yaml
window:
  chain: ethereum
  blocks: [26316189, 26343605]
inputs:
  - name: usdc_flows
    strategy: history
    source: ethereum.erc20_transfers
    filter: {tokens: ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"]}
```

`bj answer` then adds a `coverage` check. After it passes, run the cross-check in [../references/checks.md](../references/checks.md).

## Sandboxed shells

If `pnpm ingest` fails with `listen EPERM`, or Portal calls fail with `ENOTFOUND` behind a proxy, run the source directly in its package with `NODE_USE_ENV_PROXY=1 node --import tsx src/index.ts`. A source run without network access to Portal hangs at "Run started" with no error. Installing `better-sqlite3`, which the factory pattern needs, wants `npm_config_cache` set to a writable folder.
