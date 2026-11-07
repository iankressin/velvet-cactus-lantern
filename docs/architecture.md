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

Five sources read wallet balances: ETH, ERC-20 tokens, SOL, SPL tokens and BTC. The EVM sources, `evm-eth-balances` and `evm-erc20-balances`, read at `BLOCK_NUMBER`: a block number, or `latest`, `safe` or `finalized`, which each run turns into a number once at the start. A Solana RPC serves only current state, so the Solana sources read at the latest finalized slot, and each run adds a new reading, keyed by the slot it read. The Bitcoin source reads every wallet with one `scantxoutset` call through Dshackle, which scans the UTXO set at the chain tip in about a minute. Only the OnFinality upstream serves that call. Each run adds a new reading, keyed by the height it read. `analytics.latest_balances` holds each wallet's latest balance of each asset on all three chains, in the asset's base units (satoshis for BTC). On Solana its `block_number` is the slot.

Each chain reaches `latest_balances` through one model in `transformation/models/intermediate/balances/`, `int_<chain>_balances`, which puts the chain's rows in the shape the mart reads: `chain`, `wallet`, `asset_type`, `asset`, `block_number` and `balance`, with no null balance. The mart only stacks these models and keeps each wallet's latest reading of each asset. To add a chain, add its model, one `union all` branch in `latest_balances.sql`, and the chain to the mart's `accepted_values`. See [transformation/README.md](../transformation/README.md) `## Adding a chain`.

A stream source, `evm-erc20-transfers`, loads ERC-20 transfers on any EVM chain. Each run reads its chain from `CHAIN`, which Dagster sets from the source's entry in `ingestion/sources.json`, and that chain's `PORTAL_URL`, `START_BLOCK` and `addresses.json` from `chains/<chain>/` in the package. Through Pipes it reads every Transfer of the chain's tokens, or with `wallets` listed only those into or out of the wallets, from `START_BLOCK` to Portal's finalized head, and each run resumes where the last one stopped. Each chain loads into `raw.<chain>_erc20_transfers` with a cursor of its own; Ethereum, Arbitrum and Base are set up. The `transfers` pipeline builds `analytics.erc20_transfers` from them, one row per transfer, with a `chain` column, in the token's base units. Three more stream sources, `evm-uniswap-v2`, `-v3` and `-v4`, load the pool creations and Swaps of Uniswap pools that trade the tokens in each chain's `addresses.json`, each version in its own raw table, with the transactions they came from as records of their own. v2 and v3 follow their factory's pools with Pipes' factory pattern, which keeps the pools it found in each chain's `factory.sqlite`. The `dex` pipeline builds `analytics.dex_trades` from them, one row per trade, with each version's sign rule applied in its own intermediate model. A call source, `evm-address-code`, reads each address's code with `eth_getCode` on any EVM chain, laid out like `evm-erc20-transfers`: `chains/<chain>/` holds the chain's `EVM_RPC_URL` and the `addresses.json` to read. The `labels` pipeline builds `analytics.address_labels` from it and the exchange labels in `transformation/seeds/cex_addresses.csv`, one row per address per chain, with `kind` set to exchange, contract or eoa. The balances and Uniswap packages currently have only `chains/ethereum/`. The `transfers` pipeline also builds `analytics.classified_transfers`, which adds to each transfer the kind of address on each side (exchange, deposit address, contract, eoa or bridge) and a category. It reads `address_labels`, so the `transfers` job runs `evm-address-code` and the `labels` models too.

A call source, `binance-candles`, loads price candles (Binance calls them klines) from its public market-data API, `data-api.binance.vision`, into `raw.binance_candles`. Its `tokens.json` lists the tokens and the one quote asset they trade against, such as `{ "quote": "USDT", "tokens": ["BTC", "ETH", "UNI"] }`. Each run first asks Binance for each pair's first candle since `START_TIME`, which checks the pair exists (an unknown one fails the run and names the token) and finds where trading began. It then loads every closed candle of `CANDLE_INTERVAL` (1h by default) from there to now, 1000 candles a request, and skips the candle still open. Each run fetches the whole range again; rows are keyed by symbol, interval and open time, so a rerun writes the same rows and fills any gap. Before each set of requests it waits for the next minute when Binance's per-minute request weight nears its limit, and it stops on an IP ban. Prices and volumes stay the strings Binance sends. The `prices` pipeline builds `analytics.token_prices` from it, one row per candle of one token against its quote asset, in quote-asset units, with `exchange` set to `binance`.

A second call source, `coinbase-candles`, loads the same kind of candles from Coinbase Exchange's public market-data API, `api.exchange.coinbase.com`, into `raw.coinbase_candles`, laid out like `binance-candles`. Its `tokens.json` names Coinbase products as token and quote, such as `{ "quote": "USD", "tokens": ["BTC", "ETH", "UNI"] }` for `BTC-USD`, `ETH-USD` and `UNI-USD`. Each run first reads each product from Coinbase, which checks the pair exists (an unknown one fails the run and names the token) and warns when it is no longer trading. It then loads every closed candle of `CANDLE_INTERVAL` from the candle that holds `START_TIME` to now, 300 candles a request, since Coinbase refuses a wider range, and skips the candle still open. Coinbase names its candle lengths in seconds; the source takes them as `1m`, `5m`, `15m`, `1h`, `6h` or `1d`, Binance's names, so both exchanges' candles read alike. Coinbase sends no candle for a period with no trades, no trade count and no quote volume, and sends prices as numbers. Coinbase allows 10 public requests a second per IP and sends no header with the count used, so the source sends one chunk of at most `COINBASE_MAX_CONCURRENCY` requests a second, and a request Coinbase answers with HTTP 429 waits and is sent again, twice, before its window becomes a dead letter. The `prices` pipeline brings each exchange's candles into the mart's shape in its own intermediate model, `int_binance_token_prices` and `int_coinbase_token_prices`, and `analytics.token_prices` unions them, with `quote_volume` and `trades` null for Coinbase.

A stream source, `evm-chainlink-price-feeds`, loads the rounds of Chainlink price feeds on Ethereum, Arbitrum and Base, laid out like `evm-erc20-transfers`. Each feed stores its rounds in an aggregator contract, which emits an `AnswerUpdated` log for each one. `chains/<chain>/addresses.json` lists the aggregators to read, and each run reads their logs from `START_BLOCK`, the first block of 2026-10-01 UTC, to Portal's finalized head, into `raw.<chain>_chainlink_price_feeds`. The log names no feed, so the seed `transformation/seeds/chainlink_feeds.csv` maps each aggregator to its feed, proxy, phase, decimals and heartbeat. An aggregator added to `addresses.json` needs a row there. The `prices` pipeline builds `analytics.oracle_prices` from them, one row per round of one feed, with the answer scaled by the feed's decimals into a price in quote units, and the round id the feed's proxy reports. A warn test, `oracle_prices_within_heartbeat`, lists each feed in the seed with no round in the two heartbeats before the last block its chain's source read, the cursor in `raw._sync`. That usually means Chainlink moved the feed to a new aggregator. Add the new aggregator to `addresses.json` and to the seed with its phase, and keep the old one in both, so the rounds already loaded keep their feed. Then reset the source as [history-source.md](../.claude/skills/blockjuice/workflows/history-source.md#reuse-before-you-build) says: delete its row from `raw._sync` and truncate `raw.<chain>_chainlink_price_feeds`. The cursor has already passed the new aggregator's first rounds, so only a reload from `START_BLOCK` picks them up.

A call source, `evm-erc20-metadata`, reads each token's `name()`, `symbol()` and `decimals()` on any EVM chain. It is laid out like `evm-address-code`, so `chains/<chain>/` holds the chain's `EVM_RPC_URL` and an `addresses.json` that lists `tokens`. Each run reads every token at `BLOCK_NUMBER` and adds a reading to `raw.<chain>_erc20_metadata`, keyed by block and token. Some old tokens, such as MKR, return their name and symbol as `bytes32` instead of a string. The source reads those too and strips the zero bytes that pad them. A token whose contract has no `decimals()`, or whose call reverts, gets a null instead of a failed call. Ethereum, Arbitrum and Base are set up. The `tokens` pipeline builds `analytics.tokens` from them, one row per token per chain with its latest reading. Join on `chain` and `token`, never on `symbol`. Several tokens share a symbol, and one token has a different address on each chain. A null `decimals` means the contract does not say, so do not assume 18.

## Repo layout

```
.
├── .claude/skills/blockjuice/  # the skill: SKILL.md routes to workflows/ and references/
├── answers/<slug>/             # one answer per question, kept out of git: question.yaml, answer.json, answer.md, results/
├── catalog/protocols/<name>/   # contracts, events and ABIs of a protocol, proven on real logs
├── docker-compose.yml          # includes infra/docker-compose.yml; run docker compose here
├── .env.example                # settings shared by all three tools
├── ingestion/                  # pnpm workspace
│   ├── pnpm-workspace.yaml
│   ├── tsconfig.json           # one typecheck for every package
│   ├── sources.json            # every source's exported name and table; `pnpm generate-sources` writes it
│   ├── lib/                    # @ingestion/lib: shared by all sources
│   │   └── src/
│   │       ├── index.ts        # public API for any chain
│   │       ├── source.ts       # Source and StreamSource interfaces
│   │       ├── portal.ts       # Portal client and finalized head, for stream sources
│   │       ├── warehouse/      # every Postgres write: raw tables, dead letters, cursors, the run log
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
│   ├── analyses/               # one or more dbt analyses per answer
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
(cd ingestion/sources/evm-erc20-transfers && CHAIN=ethereum pnpm ingest)
(cd ingestion/sources/evm-address-code && CHAIN=arbitrum pnpm ingest)
(cd ingestion/sources/solana-sol-balances && pnpm ingest)
(cd ingestion/sources/solana-spl-balances && pnpm ingest)
(cd ingestion/sources/bitcoin-btc-balances && pnpm ingest)
(cd ingestion/sources/binance-candles && pnpm ingest)
(cd ingestion/sources/coinbase-candles && pnpm ingest)
(cd ingestion/sources/evm-chainlink-price-feeds && CHAIN=ethereum pnpm ingest)
(cd transformation && ../orchestration/.venv/bin/dbt build)
(cd orchestration && uv run pytest)
```

## Ask a question

Open the repo in Claude Code and ask a question about chain data, or type `/bj <question>` (`/blockjuice` also works). The blockjuice skill in `.claude/skills/blockjuice/` scopes the question, finds the marts that hold the data or builds them, writes a dbt analysis, checks the result and writes the answer to `answers/<slug>/`:

- `question.yaml` says what the answer counts and over which data.
- `answer.json` holds the value, the checks and where the data came from. `bj answer` writes it.
- `answer.md` is the answer in words.
- `results/` holds one CSV per analysis.
- `reports/` holds what `bj report` builds: XLSX, PDF and Word files, and the id of the answer's Google Doc. Git ignores it.

`answers/tracked-wallets-eth/` is an example. The skill reads state through the balance sources and history through stream sources, which load events over a range of blocks. When a question involves a protocol it doesn't know, it first writes the protocol's contracts, events and their meaning to `catalog/protocols/<name>/`, each proven on a real transaction. `catalog/protocols/uniswap/` is the first entry. `.mcp.json` registers the SQD Portal MCP, which the skill uses to estimate a load and to cross-check a history answer.

The skill runs every mechanical step through the `bj` CLI, whose long name is `blockjuice`. It lives in `orchestration/pipeline/cli/` and reads `.env` itself. Run it from the repo root:

```sh
uv run --project orchestration bj --help
```

| Command | What it does |
|---|---|
| `bj answer <slug>` | Runs the answer's analyses, writes `results/` and `answer.json`, and checks the inputs: dbt tests, dead letters, the last successful run and, for history sources, coverage of the window. Exits 1 when a check fails. |
| `bj run <pipeline>` | Runs one pipeline's Dagster job in-process, after `dbt parse`. |
| `bj install` | Sets up a checkout and starts nothing: copies each missing `.env` from its `.env.example` and checks them, runs `pnpm install --frozen-lockfile` in `ingestion/`, and runs `dbt parse`. Never overwrites an `.env`. Exits 2 when pnpm is missing, and 1 when an `.env` lacks a required key or pnpm fails. |
| `bj dev` | Runs `bj install`, starts the stack with `docker compose up -d`, runs the checks of `bj doctor` less Dagster's port, then hands over to `dagster dev`. Exits 2 when port 3000 is in use or a tool is missing, and 1 when a step or check failed. |
| `bj doctor [--copy-env]` | Checks the local setup: `.env` and each source's `.env` against their `.env.example` (keys by name, never values), the compose ports, the warehouse, the eRPC and Dshackle health endpoints, and the tool versions `mise.toml` pins. `--copy-env` copies `.env.example` to each source `.env` that is missing. Exits 1 when a check failed. |
| `bj coverage [<source>.<table>]` | Prints the blocks each history source has loaded: `START_BLOCK` to the cursor Pipes keeps in `raw._sync`, and the addresses it read. |
| `bj check <slug> <name> <passed\|failed> <detail>` | Records a check the agent ran itself, such as a cross-check against Portal, in `answer.json`. Exits 1 when it failed. |
| `bj blocks <chain> <from> [<to>]` | Turns UTC times into the first and last block of the window, read from SQD Portal for eleven EVM chains, including Ethereum, Arbitrum and Base. An unknown chain name prints the list. |
| `bj new-source <source> <table> --like <package>` | Does the three steps of Add a source, starting from a copy of an existing source. |
| `bj report <slug> [--format xlsx,pdf,docx,gdoc]` | Builds the answer's reports from `answer.json`, `answer.md` and `results/`. `gdoc` uploads a Google Doc and needs the Google settings in `.env.example`. |

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

`uv run --project orchestration bj new-source <source> <table> --like <package>` does steps 1 to 3 from a copy of `ingestion/sources/<package>/`. From an `evm-*` package it creates `evm-<table>/` with only `chains/<source>/`, copying that chain's settings or another chain's settings when no matching folder exists. Then edit the copied `src/`, `addresses.json` and the staging stub. Reading the source from a mart, and scheduling that mart in `PIPELINES`, stay hand steps: see [Add a pipeline](#add-a-pipeline), and `## Adding a chain` in [transformation/README.md](../transformation/README.md). By hand:

1. Copy a suitable package to `ingestion/sources/<source>-<table>/` (underscores in the table name become hyphens), rename the package to `@ingestion/<source>-<table>`, edit `src/source.ts`, and run `pnpm install` in `ingestion/`. The source adds its own dependencies (API client, schemas) to its own `package.json`; code that several sources share goes in `lib/`. Chain-specific settings belong with the package under `chains/<chain>/` for `evm-*` sources; shared chain clients live in `lib/src/<chain>/`, whose `index.ts` and `lib/package.json` define the public `@ingestion/lib/<chain>` entry point.
2. Add `transformation/models/staging/<source>/` with a sources yml and the `stg_` models.
3. Run `pnpm generate-sources` in `ingestion/`. It rewrites `ingestion/sources.json`, the list of the `name` and `table` every package exports from `src/source.ts`, with the package's folder. Dagster builds its `SOURCES` from that file, so nothing lists the sources by hand, and the orchestration tests fail while the file is stale.

The dbt source name and table name must match the `name` and `table` the source exports. Dagster keys each dbt source as `[source, table]`, and the ingestion asset uses the same key, so Dagster links them. A test names any pair that drifts.

To load ERC-20 transfers on another EVM chain, extend `evm-erc20-transfers` instead of copying it: add `chains/<chain>/` with a `.env.example` that sets `PORTAL_URL` and `START_BLOCK` and an `addresses.json` with `tokens`, run `pnpm generate-sources` in `ingestion/`, add `transformation/models/staging/<chain>/` like `staging/base/`, and add an `int_<chain>_erc20_transfers` branch to the `erc20_transfers` mart. The generator calls the package's `forChain(chain)` once per folder in `chains/` and records that folder as the entry's `settings` in `sources.json`, where `bj coverage` and `bj doctor` find it; Dagster passes the chain to the run as `CHAIN`. `loadEnv` reads the environment first, then `chains/<chain>/.env`, its `.env.example` and the package `.env`, ignoring any file's `CHAIN`. `evm-address-code`, `evm-erc20-metadata`, `evm-eth-balances` and `evm-erc20-balances` take a new chain the same way, with `EVM_RPC_URL` in its `chains/<chain>/.env.example`. The `evm-uniswap-v2`, `-v3` and `-v4` packages also take a chain folder: it holds `PORTAL_URL`, `POOLS_START_BLOCK`, `START_BLOCK` and `FACTORY_DB`, and the chain's factory or PoolManager is configured in `src/source.ts`.

A **call source** makes calls, such as RPC reads at one block, and its `src/source.ts` exports a `Source`. Before its first run, check that:

- The `Source` has a zod `call` schema. Each run parses its pending dead letters with it, and a dead letter whose call no longer parses is parked for a person.
- A failed call's `id` is the `callId` of the record the call would have produced. A record with that `callId` clears the dead letter. `settleCalls` in `lib/` keys both from one id function.
- `extract(env, retry)` makes the retried calls next to the new ones, as `[...newCalls, ...retry]`. A failed call does not fail the run: the records that did arrive are written, and the failed calls wait as dead letters for the next run. A call that fails five runs in a row is parked.
- `extract` reads `addresses.json` with `readJson` from `@ingestion/lib`, so a bad file fails the run and `runSource` logs why.
- `name` and `table` match the dbt source and table and the entry in `sources.json`, as above.

A **stream source** reads blocks through a [Pipes](https://docs.sqd.dev/en/sdk/pipes-sdk) stream instead of making calls; scaffold one with `--like` one of the `evm-uniswap-v*` packages or `arbitrum-token-bridge`. Its `src/source.ts` exports a `StreamSource`, whose `stream(env)` returns the stream. Map the stream's outputs to records with `.pipe()`, and end its range at `finalizedHead(portalClient(url))` so each run ends. `runSource` pipes the stream into the warehouse, where Pipes keeps the source's cursor in `raw._sync` and saves it in the same transaction as the batch's records. Each run resumes after the cursor and reads at most `maxBlocksPerRun` blocks, plus the rest of the batch that passes it. A stream source has no calls, so it has no dead letters: an error, from Portal or from the warehouse, fails the run, nothing from the batch it was writing commits, and the next run resumes after the last batch that did. To read a stream source again from its start, delete its row from `raw._sync`, whose `id` is `<source>_<table>`.

## Add a pipeline

A pipeline is the models in `transformation/models/marts/<pipeline>/` and every asset they read from, ingestion included. Each pipeline runs as its own Dagster job, on its own schedule.

1. Add the pipeline's output models to `transformation/models/marts/<pipeline>/`, and any models that only it reads to `transformation/models/intermediate/<pipeline>/`. Staging models stay in `staging/<source>/`, because any pipeline can read them.
2. Add the pipeline's name and cron schedule to `PIPELINES` in `orchestration/pipeline/schedules.py`.

If the pipeline reads a new source, also follow [Add a source](#add-a-source). Two pipelines that read the same source each run it. The orchestration tests fail when an asset belongs to no scheduled pipeline.

## Use another warehouse

Change `ingestion/lib/src/warehouse/`, the adapter in `transformation/profiles.yml`, and `dbt-postgres` in `orchestration/pyproject.toml`.
