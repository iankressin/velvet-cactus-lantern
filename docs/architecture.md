# Architecture

How BlockJuice is laid out and how the pieces fit. For a short product overview and quick start, see the [README](../README.md). Terms match [GLOSSARY.md](../GLOSSARY.md).

## Data flow

| Stage | Tool | Folder |
|-----------|------------|-------------------|
| Extract + load | TypeScript | `ingestion/` |
| Transform | dbt | `transformation/` |
| Orchestrate | Dagster | `orchestration/` |

A TypeScript source writes raw JSON rows into `raw.<source>_<table>`. dbt reads them through `source()`, then builds staging views and mart tables in the `analytics` schema. Dagster runs both as one asset graph.

### What ships today

Five sources read wallet balances: ETH, ERC-20 tokens, SOL, SPL tokens and BTC. They take the wallets and tokens from one file, `ingestion/wallet-assets.csv` (set by `WALLET_ASSETS_CSV`), with a `blockchain,wallet_address,token_address` row for each wallet asset and an empty `token_address` for the native asset. Each source reads only the rows of its own chain and asset type through `readWalletAssets` in `@ingestion/lib/wallet-assets`, so a bad row fails only the source that reads it. The EVM sources, `evm-eth-balances` and `evm-erc20-balances`, read at `BLOCK_NUMBER`: a block number, or `latest`, `safe` or `finalized`, which each run turns into a number once at the start. A Solana RPC serves only current state, so the Solana sources read at the latest finalized slot, and each run adds a new reading, keyed by the slot it read. The Bitcoin source reads every wallet with one `scantxoutset` call through Dshackle, which scans the UTXO set at the chain tip in about a minute. Only the OnFinality upstream serves that call. Each run adds a new reading, keyed by the height it read. `analytics.latest_balances` holds each wallet's latest balance of each asset on all three chains, under the columns the input file uses: `blockchain`, `wallet_address` and `token_address`, which is null for the native asset. `balance` is in the asset's base units (satoshis for BTC), and `balance_tokens` is in whole tokens. The native decimals come from the intermediate models and each token's from `analytics.tokens`. So the `balances` job also runs `tokens` and every metadata source it reads: ERC-20 metadata on Ethereum and SPL metadata on Solana. A failed load in any of them skips the job's dbt step, `latest_balances` included. A token with no decimals in `tokens` has null `decimals` and `balance_tokens`. On Solana `block_number` is the slot.

Each chain reaches `latest_balances` through one model in `transformation/models/intermediate/balances/`, `int_<chain>_balances`, which puts the chain's rows in the shape the mart reads: `chain`, `wallet`, `asset_type`, `asset`, `decimals`, `block_number` and `balance`, with no null balance. `decimals` holds the native asset's decimals on native rows and is null on token rows. The mart stacks these models, keeps each wallet's latest reading of each asset, then joins `tokens` for token decimals. To add a chain, add its model, one `union all` branch in `latest_balances.sql`, and the chain to the `accepted_values` of the mart's `blockchain`. See [transformation/README.md](../transformation/README.md) `## Adding a chain`.

A call source, `evm-erc20-metadata`, reads each token's `name()`, `symbol()` and `decimals()` on any EVM chain. Its `chains/<chain>/` holds the chain's `EVM_RPC_URL` and an `addresses.json` that lists `tokens`. On Ethereum it also reads every token in the `erc20` rows of the wallet asset CSV, so each token a balance source reads has its decimals. A token in both lists is read once. Each run reads every token at `BLOCK_NUMBER` and adds a reading to `raw.<chain>_erc20_metadata`, keyed by block and token. Some old tokens, such as MKR, return their name and symbol as `bytes32` instead of a string. The source reads those too and strips the zero bytes that pad them. A token whose contract has no `decimals()`, or whose call reverts, gets a null instead of a failed call. Only Ethereum is set up. `analytics.tokens` holds one row per token per chain with its latest reading. Join on `chain` and `token`, never on `symbol`. Several tokens share a symbol, and one token has a different address on each chain. A null `decimals` means the contract does not say, so do not assume 18.

A call source, `solana-spl-metadata`, reads the same for SPL tokens. It is laid out like `solana-spl-balances`: it reads the mints in the `spl` rows of the wallet asset CSV and in its `addresses.json`, each once, and each run reads at the latest finalized slot and adds a reading to `raw.solana_spl_metadata`, keyed by slot and mint. One `getMultipleAccounts` request per mint reads the mint and its Metaplex metadata account at the same slot. Decimals come from the mint. A name and symbol can live in two places, and the source keeps both: a Token-2022 mint's `tokenMetadata` extension, as PYUSD has, and the Metaplex account, as USDC and USDT have. `int_solana_spl_metadata` takes the extension's first. The source drops the zero bytes that pad Metaplex names. An address that is not a mint, such as a wallet, gets null decimals instead of a failed call. A token-program account that the RPC sends back unparsed fails its call instead, so the mint's last good reading stays in `analytics.tokens`. In `analytics.tokens`, a Solana row keys on the mint as written, since base58 is case-sensitive, and puts its slot in `block_number`.

Every source above is a call source. No stream source ships now.

## Repo layout

```
.
├── docker-compose.yml          # includes infra/docker-compose.yml; run docker compose here
├── .env.example                # settings shared by all three tools
├── ingestion/                  # pnpm workspace
│   ├── pnpm-workspace.yaml
│   ├── tsconfig.json           # one typecheck for every package
│   ├── sources.json            # every source's exported name and table; `pnpm generate-sources` writes it
│   ├── lib/                    # @ingestion/lib: shared by all sources
│   │   └── src/
│   │       ├── index.ts        # public API for any chain
│   │       ├── source.ts       # the Source interface
│   │       ├── warehouse/      # every Postgres write: raw tables, dead letters, the run log
│   │       ├── evm/            # @ingestion/lib/evm: env, addresses, client, connect()
│   │       ├── solana/         # @ingestion/lib/solana: env, addresses, client
│   │       ├── bitcoin/        # @ingestion/lib/bitcoin: env, addresses, client
│   │       ├── logger.ts       # the pino logger
│   │       └── run/            # runSource(): extract + load, logs, the run report and its metrics
│   └── sources/
│       └── <source>/           # @ingestion/<source>: one package per source
│           ├── package.json    # `ingest` script, depends on @ingestion/lib
│           └── src/
│               ├── source.ts   # the Source definition
│               └── index.ts    # entry point: runSource(source)
├── transformation/             # dbt project (profiles.yml lives here)
│   └── models/
│       ├── staging/<source>/   # sources yml + stg_ models, one folder per source
│       ├── intermediate/<pipeline>/
│       └── marts/<pipeline>/   # a pipeline's output tables, one folder per pipeline
├── infra/                      # the Postgres warehouse, eRPC, Dshackle and monitoring
│   ├── postgres/init.sql       # eRPC database and monitor role, then runs ops.sql
│   ├── postgres/ops.sql        # the ops run log, plain SQL so tests can load it
│   ├── prometheus/
│   └── grafana/
│       ├── build_dashboards.py # writes dashboards/ingestion.json and pipeline.json
│       └── check_dashboards.py # runs every dashboard query through Grafana
└── orchestration/
    ├── pipeline/
    │   ├── definitions.py      # Dagster entry point
    │   ├── project.py          # paths + DbtProject
    │   ├── run_log.py          # adds each dbt build to ops.dbt_invocations and ops.dbt_node_runs
    │   ├── cli/                # the bj CLI
    │   ├── assets/ingestion.py # one asset per TypeScript source
    │   ├── assets/dbt.py       # every dbt model as an asset
    │   └── schedules.py        # one job and schedule per pipeline
    └── tests/
```

## Local setup (detail)

Needs Node 24 and [pnpm](https://pnpm.io), which `mise.toml` pins (`mise install` sets up both), [uv](https://docs.astral.sh/uv/) and Docker.

```sh
uv run --project orchestration bj dev
```

`uv run` creates `orchestration/.venv` and installs the Python packages before `bj` starts. `bj dev` first runs `bj install`, which:

1. Copies `.env.example` to `.env` at the root and in each source package that has none, and checks each `.env` as `bj doctor` does. It never overwrites an `.env`.
2. Runs `pnpm install --frozen-lockfile` in `ingestion/`.
3. Runs `dbt parse`, which writes `transformation/target/manifest.json`. Dagster needs that file to load its assets.

`bj dev` then runs `docker compose up -d`, which returns once `warehouse-init` has set up the warehouse, and runs the checks of `bj doctor` except Dagster's port, which stays closed until Dagster starts. If none fails, it hands the terminal to `dagster dev` in `orchestration/`, with `.env` loaded. Ctrl-C stops Dagster and leaves the stack up; `docker compose down` stops the stack. Run `bj install` alone to set up without starting anything. Both commands are safe to run again.

`uv run --project orchestration bj doctor` checks the setup: the env files and their keys, the ports, the warehouse, eRPC and Dshackle, and the tool versions.

Open http://localhost:3000 and materialize all assets.

In `ingestion/`, a package imports another by name (`import { runSource } from "@ingestion/lib"`). Code for one chain comes from that chain's subpath: `import { connect } from "@ingestion/lib/evm"`. Inside a package, import its own files by their path from its `src`, with the `.ts` extension: `import { fetchBalances } from "#src/balances.ts"`. Each package defines `#src/` in the `imports` field of its `package.json`. Packages export their `.ts` source directly, so there is no build step; `pnpm typecheck` at `ingestion/` checks every package.

Each layer also runs alone. dbt and the tests read the root settings from the environment, so load `.env` first with `set -a && source .env && set +a`:

```sh
(cd ingestion/sources/evm-eth-balances && CHAIN=ethereum pnpm ingest)
(cd ingestion/sources/evm-erc20-balances && CHAIN=ethereum pnpm ingest)
(cd ingestion/sources/solana-sol-balances && pnpm ingest)
(cd ingestion/sources/solana-spl-balances && pnpm ingest)
(cd ingestion/sources/bitcoin-btc-balances && pnpm ingest)
(cd transformation && ../orchestration/.venv/bin/dbt build)
(cd orchestration && uv run pytest)
```

## The bj CLI

The `bj` CLI, whose long name is `blockjuice`, sets up a checkout, checks it and runs pipelines. It lives in `orchestration/pipeline/cli/` and reads `.env` itself. Run it from the repo root:

```sh
uv run --project orchestration bj --help
```

| Command | What it does |
|---|---|
| `bj run <pipeline>` | Runs one pipeline's Dagster job in-process, after `dbt parse`. |
| `bj install` | Sets up a checkout and starts nothing: copies each missing `.env` from its `.env.example` and checks them, runs `pnpm install --frozen-lockfile` in `ingestion/`, and runs `dbt parse`. Never overwrites an `.env`. Exits 2 when pnpm is missing, and 1 when an `.env` lacks a required key or pnpm fails. |
| `bj dev` | Runs `bj install`, starts the stack with `docker compose up -d`, runs the checks of `bj doctor` less Dagster's port, then hands over to `dagster dev`. Exits 2 when port 3000 is in use or a tool is missing, and 1 when a step or check failed. |
| `bj doctor [--copy-env]` | Checks the local setup: `.env` and each source's `.env` against their `.env.example` (keys by name, never values), the compose ports, the warehouse, the eRPC and Dshackle health endpoints, and the tool versions `mise.toml` pins. `--copy-env` copies `.env.example` to each source `.env` that is missing. Exits 1 when a check failed. |

## Monitoring

`docker compose up -d` also starts Prometheus, a Pushgateway, postgres-exporter and Grafana. You can view Grafana without logging in. Sign in as `admin`/`admin` to edit or use Explore.

- Pipeline: http://localhost:3001/d/pipeline, the report of every run. Click a run in Every run to see its steps, and to zoom the warehouse and eRPC panels to the time it ran.
- Ingestion: http://localhost:3001/d/ingestion
- eRPC: http://localhost:3001/d/erpc_metrics, the dashboard that ships with the eRPC release pinned in `infra/docker-compose.yml`. Many of its panels stay empty until eRPC sees what they track, such as errors, rate limits or lagging upstreams.
- Dshackle: http://localhost:3001/d/qkG2pqWnp, the dashboard from the Dshackle release pinned in `infra/docker-compose.yml`, edited to work here. Dshackle is the Bitcoin RPC proxy at http://localhost:8545/bitcoin, and http://localhost:8082/health?detailed shows the state of each upstream.
- Prometheus: http://localhost:9090

A source run ends before Prometheus could scrape it, so each run pushes its result to the Pushgateway at `PUSHGATEWAY_URL`, and Prometheus scrapes that. The result covers whether the run succeeded, when it finished, how long it took, the records it wrote, its failed calls and the dead letters it retried, labelled by source and table. It also counts the dead letters left waiting, as `ingestion_dead_letters` with `state` set to `pending` (retried next run) or `parked` (failed too often or no longer matches the source's call schema, waits for a person). With `PUSHGATEWAY_URL` unset, a run pushes nothing.

`infra/prometheus/alerts.yml` holds the alert rules: a failed source run, no successful run for over 25h, parked dead letters, a scrape target down, eRPC upstream and network error rates, and Dshackle with no available upstream. Prometheus evaluates them and shows them at http://localhost:9090/alerts; Grafana lists the same rules under Alerting, and its built-in alerting on :3001 is where notifications get set up in v1, rather than a separate Alertmanager. `docker compose ps` shows Dshackle as healthy once its `/health` endpoint answers. eRPC's image has no shell to run a check from, so it has no compose healthcheck; from the host, `curl -i http://localhost:4000/healthcheck` answers 200 while an upstream is up.

Prometheus keeps only each source's latest result, so the history of every run lives in the warehouse, in the `ops` schema that `infra/postgres/ops.sql` creates:

- `ops.ingestion_runs` holds one row per source run. `runSource` writes it, with the error when the run failed and the time spent writing to the warehouse.
- `ops.dbt_invocations` and `ops.dbt_node_runs` hold each dbt build and each model and test in it. The Dagster dbt asset writes them from `run_results.json`, so a `dbt build` run by hand is not recorded.
- `ops.pipeline_runs` is a view with one row per Dagster run. Dagster passes its run id to each source as `DAGSTER_RUN_ID`, which ties the ingestion rows to the dbt rows of the same run.

Grafana reads the warehouse as `monitor`, a role that can read everything and change nothing. The warehouse loads `pg_stat_statements` for the query panels. The eRPC panels count only sources whose `EVM_RPC_URL` or `SOLANA_RPC_URL` points at eRPC.

To change a dashboard, edit `infra/grafana/build_dashboards.py`, run it, then check every query with `python3 infra/grafana/check_dashboards.py`.

## Logging

Ingestion code logs through the pino `logger` from `@ingestion/lib`, never `console`. It writes JSON lines, and Dagster shows each line as a log event at its own level. In a terminal the lines are pretty-printed. `LOG_LEVEL` sets the level, `info` by default. An unknown level logs a warning and falls back to `info`. `runSource` logs any error as fatal and sets the exit code, so a failed run leaves one log line with the stack, not Node's crash output.

## Add a source

Three steps add a source. To read it from a mart and schedule that mart in `PIPELINES`, see [Add a pipeline](#add-a-pipeline) and `## Adding a chain` in [transformation/README.md](../transformation/README.md).

1. Copy a suitable package to `ingestion/sources/<source>-<table>/` (underscores in the table name become hyphens), rename the package to `@ingestion/<source>-<table>`, edit `src/source.ts`, and run `pnpm install` in `ingestion/`. The source adds its own dependencies (API client, schemas) to its own `package.json`; code that several sources share goes in `lib/`. Chain-specific settings belong with the package under `chains/<chain>/` for `evm-*` sources; shared chain clients live in `lib/src/<chain>/`, whose `index.ts` and `lib/package.json` define the public `@ingestion/lib/<chain>` entry point.
2. Add `transformation/models/staging/<source>/` with a sources yml and the `stg_` models.
3. Run `pnpm generate-sources` in `ingestion/`. It rewrites `ingestion/sources.json`, the list of the `name` and `table` every package exports from `src/source.ts`, with the package's folder. Dagster builds its `SOURCES` from that file, so nothing lists the sources by hand, and the orchestration tests fail while the file is stale.

The dbt source name and table name must match the `name` and `table` the source exports. Dagster keys each dbt source as `[source, table]`, and the ingestion asset uses the same key, so Dagster links them. A test names any pair that drifts.

To read an `evm-*` source on another EVM chain, extend its package instead of copying it. Add `chains/<chain>/` with a `.env.example` that sets `EVM_RPC_URL`, and for `evm-erc20-metadata` an `addresses.json` that lists `tokens`. Run `pnpm generate-sources` in `ingestion/`, and add `transformation/models/staging/<chain>/` like `staging/ethereum/`. The generator calls the package's `forChain(chain)` once per folder in `chains/` and records that folder as the entry's `settings` in `sources.json`, where `bj doctor` finds it. Dagster passes the chain to the run as `CHAIN`. `loadEnv` reads the environment first, then `chains/<chain>/.env`, its `.env.example` and the package `.env`, ignoring any file's `CHAIN`. The wallet asset CSV can name only Ethereum among EVM chains, so on another chain `evm-eth-balances` and `evm-erc20-balances` fail their run, and `evm-erc20-metadata` reads only the chain's `addresses.json`.

A **call source** makes calls, such as RPC reads at one block, and its `src/source.ts` exports a `Source`. Before its first run, check that:

- The `Source` has a zod `call` schema. Each run parses its pending dead letters with it, and a dead letter whose call no longer parses is parked for a person.
- A failed call's `id` is the `callId` of the record the call would have produced. A record with that `callId` clears the dead letter. `settleCalls` in `lib/` keys both from one id function.
- `extract(env, retry)` makes the retried calls next to the new ones, as `[...newCalls, ...retry]`. A failed call does not fail the run: the records that did arrive are written, and the failed calls wait as dead letters for the next run. A call that fails five runs in a row is parked.
- `extract` reads its addresses inside the run, `addresses.json` with `readJson` from `@ingestion/lib` or the wallet asset CSV with `readWalletAssets` from `@ingestion/lib/wallet-assets`, so a bad file fails the run and `runSource` logs why.
- `name` and `table` match the dbt source and table and the entry in `sources.json`, as above.

`runSource` runs only call sources. It cannot run a **stream source**, which reads blocks through a [Pipes](https://docs.sqd.dev/en/sdk/pipes-sdk) stream instead of making calls.

## Add a pipeline

A pipeline is the models in `transformation/models/marts/<pipeline>/` and every asset they read from, ingestion included. Each pipeline runs as its own Dagster job, on its own schedule.

1. Add the pipeline's output models to `transformation/models/marts/<pipeline>/`, and any models that only it reads to `transformation/models/intermediate/<pipeline>/`. Staging models stay in `staging/<source>/`, because any pipeline can read them.
2. Add the pipeline's name and cron schedule to `PIPELINES` in `orchestration/pipeline/schedules.py`.

If the pipeline reads a new source, also follow [Add a source](#add-a-source). Two pipelines that read the same source each run it. The orchestration tests fail when an asset belongs to no scheduled pipeline.

## Use another warehouse

Change `ingestion/lib/src/warehouse/`, the adapter in `transformation/profiles.yml`, and `dbt-postgres` in `orchestration/pyproject.toml`.
