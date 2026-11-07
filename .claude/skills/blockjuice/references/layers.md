# What each layer does

The repo is ELT. Ingestion extracts data and loads it raw. dbt does every transformation. Keeping raw data raw means a wrong rule is fixed in SQL and rebuilt, without fetching anything again.

## Ingestion: extract and load

`ingestion/sources/<package>/`, in TypeScript.

- One source and one raw table per contract system: one version of one protocol on one chain, such as Uniswap v3 on Ethereum. Never load two versions or two protocols into one table, even when their events look alike, since each version's schema and rules change on their own. Name the package `evm-<protocol>-<version>`, such as `evm-uniswap-v3`, with one folder per chain in its `chains/`: each chain is a source of its own and loads `raw.<chain>_<protocol>_<version>`. A protocol that lives on one chain is named for that chain, such as `arbitrum-token-bridge`.
- Fetch data as the chain returns it. Each record is one item Portal or the RPC returns: a log with its ABI-decoded arguments, a transaction, a trace, or a state call's result at a pinned block.
- Never combine items in a source. When the models need a log's transaction, such as its `tx.from`, write the transactions as records of their own, keyed by hash, and join them in dbt.
- Decide what to fetch, and only that: the block range, the contracts, the events, filters on indexed parameters, and the children a factory creates through Pipes' factory pattern.
- Key each record by its place in the chain, such as `<block>:<logIndex>`, so a rerun writes the same row.
- Read only the source's own inputs (its `.env`, its `addresses.json`) and the chain. Never read another source's raw table or a dbt model.
- Interpret nothing: no joins, no sign rules, no buy or sell, no unit conversion, no prices, no aggregation.
- Never change `ingestion/lib`, `runSource` or the Source contract to add a source. Each source checks its own inputs.

## Raw tables

`raw.<chain>_<table>` holds each record's `data` as the source wrote it. Nothing edits it after load. The dead letters, the run log and Pipes' cursor sit beside it.

## Staging

`transformation/models/staging/<source>/`, one view per raw table and kind of record. A raw table that holds logs and transactions gets `stg_<chain>__<table>` for its logs and `stg_<chain>__<table>_transactions`. Cast each field out of `data` into a typed column and lowercase addresses. No joins and no rules.

## Intermediate

`transformation/models/intermediate/<pipeline>/`. Joins and rules live here: swaps joined to their pools, sign conventions, buy or sell, token in and out, deduplication, units. Each version gets its own model with its own rules, named `int_<chain>_<protocol>_<version>_<thing>`, such as `int_ethereum_uniswap_v3_trades`, which brings its rows into the mart's shape. Test each rule with a dbt unit test built from a real log in the protocol's catalog `NOTES.md`.

## Marts

`transformation/models/marts/<pipeline>/`. Facts that many questions reuse, such as one row per trade or per balance reading, with tests on the grain. A mart that covers several versions or protocols unions their intermediate models, with a column naming each row's version. Reconciliation tests, which compare rebuilt values with state reads, go in `transformation/tests/`.

## Analyses and answers

`transformation/analyses/<name>.sql` holds one question's filter, window and aggregation, over marts only. `answers/<slug>/` holds what `bj answer` writes and the `answer.md` you write.

## Where does it go?

| Work | Layer |
|---|---|
| Which contracts, blocks and events to fetch | ingestion, one source per protocol version |
| Decoding a log with its ABI | ingestion |
| Loading the transactions that logs came from | ingestion, as their own records |
| Joining a log to its transaction, such as for `tx.from` | intermediate |
| Casting a field, lowercasing an address | staging |
| Joining swaps to pools, finding a pool's tokens | intermediate |
| Sign rules, buy or sell, token in and out | intermediate, one model per version |
| Putting v2, v3 and v4 trades side by side | mart, as a union of the version models |
| Decimals, USD values | intermediate or mart |
| One question's filter, window and count | analysis |
