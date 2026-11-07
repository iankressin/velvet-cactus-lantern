# Add a pipeline

A pipeline is the marts in `transformation/models/marts/<pipeline>/` and everything upstream of them, sources included. Dagster runs each pipeline as its own job, on its own schedule, and both come from one line in `PIPELINES` in `orchestration/pipeline/schedules.py`. `balances` is the example.

## 1. Scaffold the source

Skip this step when every source the marts need is already in `ingestion/sources.json`.

```sh
uv run --project orchestration bj new-source <source> <table> --like <package>
```

`<source>` is the chain, such as `ethereum`, `<table>` the raw table, such as `pancakeswap_v3`, and `<package>` the folder under `ingestion/sources/` to copy. The command:

- copies the package to `ingestion/sources/<source>-<table>/` (underscores become hyphens) and sets `name` and `table` in its `src/source.ts`, so it exports the new pair and fills `raw.<source>_<table>`. A copy of an `evm-*` package is `evm-<table>/` instead, with only `chains/<source>/`, and only its `table` changes, since `forChain(chain)` names each source for its chain;
- adds the table to `transformation/models/staging/<source>/_<source>__sources.yml`, writing the file for a new source, and writes `stg_<source>__<table>.sql`, which selects `id`, `data` and `_loaded_at`;
- runs `pnpm install` and then `pnpm generate-sources` in `ingestion/`. That rewrites `ingestion/sources.json`, the list of the `name` and `table` every package exports, which Dagster builds its `SOURCES` from. Nothing lists the sources by hand.

It does not read the source from any mart, and it schedules nothing. Both stay hand steps, below. The copied code still reads the old data: edit it per [state-source.md](state-source.md) or [history-source.md](history-source.md).

## 2. By hand

`bj new-source` stops at the staging stub. Nothing scaffolds the rest, and the orchestration tests check for it:

1. Shape the staging model: cast each field out of `data` into its own column and lowercase addresses, as `stg_ethereum__erc20_balances.sql` does. Add column tests to the folder's `_<source>__models.yml`. No joins and no rules, per [../references/layers.md](../references/layers.md).
2. Read the source from a mart.
   - A new chain for `balances`: follow `## Adding a chain` in `transformation/README.md`. It adds `int_<chain>_balances` in `models/intermediate/balances/`, a `union all` branch in `latest_balances.sql`, and the chain to the mart's `accepted_values`.
   - A new kind of fact: a new mart in `models/marts/<pipeline>/`. Make it hold one kind of fact for every chain and asset it covers, such as `latest_balances`. Never build a mart for one question; the question's filter belongs in its analysis. Put models that only this pipeline reads in `models/intermediate/<pipeline>/`, where joins and rules go. When the mart stacks chains or protocol versions, give each one intermediate model that brings its rows into the mart's shape, as `int_<chain>_balances` does. Test the mart in `_<pipeline>__models.yml`: `not_null` on keys, `unique` on the grain, `accepted_values` on columns with a fixed set of values. Start the mart's SQL with a comment that says what one row is and which units it uses, as `latest_balances.sql` does.
3. Schedule it: add the pipeline's name and cron to `PIPELINES` in `orchestration/pipeline/schedules.py`. Use a daily schedule unless the user asks for another. A mart folder already in `PIPELINES` is scheduled; a new one is not until this line exists. [schedule-jobs.md](schedule-jobs.md) says how the job is selected and how to change the time.

## 3. Build, test and load

```sh
set -a && . ./.env && set +a && cd transformation && uv run --project ../orchestration dbt build --select +path:models/marts/<pipeline>
set -a && . ./.env && set +a && cd orchestration && uv run pytest
```

`test_every_asset_and_check_runs_in_a_scheduled_pipeline` in `orchestration/tests/test_definitions.py` fails until step 2.3 is done: every asset, the new source and its staging model included, must belong to a scheduled pipeline. Then materialize the pipeline end to end, sources included, with `uv run --project orchestration bj run <pipeline>`. `dagster dev` shows the new job after a restart.

## The name contract

dbt reads each source by the `name` and `table` its package exports from `src/source.ts`, and `ingestion/sources.json` is the one list of those pairs. The tests in `orchestration/tests/test_sources_json.py` fail on drift and name the pair:

- `test_sources_json_is_fresh`: the generator, run now, does not write the committed file. This happens after a `name` or `table` changed in `src/source.ts`, a package was added or removed by hand, or `bj new-source` reported that `pnpm` failed. Run `pnpm generate-sources` in `ingestion/` (after `pnpm install`, when the package is new) and commit `ingestion/sources.json`.
- `test_every_source_has_its_dbt_source_and_staging_model`: a listed pair has no table under its source in `_<source>__sources.yml` or no `stg_<source>__<table>.sql`, or a dbt source table has no package that exports it. Fix the side that is wrong, usually the yml and the model, so they match the export. When the export changes, regenerate `sources.json` as above.

Never add a source to a hand-written list. `sources.json` is generated, and Dagster reads it.
