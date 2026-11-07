# Checks

`bj answer` runs these checks and writes each one to `answer.json` as `passed` or `failed`, with a detail. It exits 1 when any check fails.

| Check | Fails when | What to do |
|---|---|---|
| `dbt_tests` | A dbt test on a model upstream of the analyses fails or errors. | Read the failing test's SQL in `transformation/target/compiled/`. Fix the model or the source, rebuild, rerun `bj answer`. |
| `dead_letters` | An input's raw table has pending or parked dead letters, so some calls never produced records and the answer may miss data. | Pending ones retry on the next run: run the pipeline again. Parked ones failed too often or no longer match the source's call schema: read their `error` in `raw._dead_letters` and tell the user. |
| `freshness` | An input has no successful run in `ops.ingestion_runs`. | Run the pipeline. If the run fails, read its `error` in `ops.ingestion_runs` and fix that first. |
| `coverage` | Only when an input names a history source. The source has not loaded the window's blocks, or the input's `filter` names addresses its `addresses.json` lacks. | Window past the cursor: run the pipeline until `bj coverage` reaches it. Window before `START_BLOCK`, or missing addresses: the source needs a reset, per [../workflows/history-source.md](../workflows/history-source.md). |

The detail of `freshness` lists when each input last loaded. Read it even when the check passes: an answer about "now" built on data from last week says so in `answer.md`.

A reconciliation test runs inside `dbt_tests` when an answer reads ERC-20 transfers. Between two balance readings inside the loaded blocks, each balance must change by its transfers in minus out. When it fails, the transfers miss something the chain counted, such as a rebase or a fee on transfer. Find which before you answer. When `dbt_tests` says `erc20_transfers_match_balances_has_pairs` warned, no two balance readings fall inside the loaded blocks, so nothing was reconciled. Run the balances pipeline once more and rerun `bj answer`, or say in the answer that the transfers were not reconciled.

You run one check yourself. `cross_check` compares one number with an independent query, and `bj check <slug> cross_check passed|failed "<detail>"` records it in `answer.json`. Rerunning `bj answer` drops it, since new results void it.
