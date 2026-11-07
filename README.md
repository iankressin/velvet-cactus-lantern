# BlockJuice

![BlockJuice, a blockchain data ELT framework](docs/images/bj-banner-2.png)

A self-hosted ELT framework and warehouse for blockchain data. You can trace any number it gives you back to raw rows, and rebuild it.

If you advise funds, treasuries or protocol teams, you know where on-chain work gets awkward. Explorers are fine for a quick look. Shared analytics platforms work until you need to own the query, the join or how long the data is kept.

BlockJuice runs in your environment. It loads chain data into your Postgres, transforms it with dbt and schedules the work with Dagster. Balances and token metadata sit next to the rest of your data, under keys and policies you set.

The result is a pipeline an analyst can read, change and hand to a client. Every step is in the repo for anyone to check.

## Why

You keep the data. Raw rows, marts and run logs live in a warehouse and repo you run. When an auditor or a client asks how a number was built, you can show them the model and the run that produced it.

Adding coverage doesn't mean building a platform. For another wallet list, EVM chain or protocol, copy a source package, regenerate `sources.json` with `pnpm generate-sources`, add the chain in dbt (see [transformation/README.md](transformation/README.md)) and schedule a pipeline. The [glossary](GLOSSARY.md) explains call sources and stream sources. The shared library already handles cursors and dead letters, so you can spend your time on the question.

When something breaks, you can see it. `bj doctor` checks your env and services before you start debugging. Grafana and the `ops.*` run log show ingestion and dbt side by side. The library keeps failed calls as dead letters instead of dropping them.

## What

| You need | What ships |
|---|---|
| Point-in-time balances | ETH, ERC-20, SOL, SPL, BTC → `analytics.latest_balances` |
| The balances you asked for, as a file | One row per line of `input/wallet-assets.csv` → `analytics.requested_balances` → `output/balances.csv` |
| Token metadata | Name, symbol and decimals of listed ERC-20 tokens on Ethereum and SPL tokens on Solana → `analytics.tokens` |
| How it runs | TypeScript extract/load → dbt → Dagster, plus Docker for the warehouse, eRPC, Dshackle and monitoring |
| How you drive it | The `bj` CLI (`install`, `dev`, `doctor`, `run`) and the Dagster UI |

The code is ordinary software engineering: typed sources, tests, schedules and docs a teammate can follow. [docs/architecture.md](docs/architecture.md) has the details.

## Quick start

You need Node 24 and [pnpm](https://pnpm.io) (both pinned in `mise.toml`), [uv](https://docs.astral.sh/uv/) and Docker.

First, set up the checkout:

```sh
uv run --project orchestration bj install
```

It copies each missing `.env` from its `.env.example`, installs the Node packages in `ingestion/` and runs `dbt parse`. It never overwrites an `.env` and starts nothing. `uv run` installs the Python packages before `bj` runs.

Then start everything:

```sh
uv run --project orchestration bj dev
```

`bj dev` does four things, in order:

1. Runs `bj install` again, which is safe to repeat.
2. Starts the Docker stack with `docker compose up -d`: the Postgres warehouse, eRPC, Dshackle, Prometheus, the Pushgateway and Grafana. It returns once the warehouse is set up.
3. Runs the `bj doctor` checks and stops if any of them fails.
4. Starts `dagster dev` in `orchestration/`, with `.env` loaded, at http://localhost:3000.

It stops at once if port 3000 is taken, since that usually means Dagster is already running. Ctrl-C stops Dagster and leaves the stack running. `docker compose down` stops the stack.

When Dagster is up, open http://localhost:3000 and materialize the assets you need. To run a pipeline from the terminal instead, use `uv run --project orchestration bj run balances`. If something looks wrong, run `bj doctor` before anything else.

## How you use it

1. Set up once with `bj install`, start the stack and Dagster with `bj dev`, then open the Dagster UI.
2. List the wallets and tokens whose balances you want in `input/wallet-assets.csv`, one `blockchain,wallet_address,token_address` row each, with `token_address` empty for the native asset. Each balance source reads its own rows from it, and `evm-erc20-metadata` and `solana-spl-metadata` read the decimals of each token in it.
3. Materialize the balances pipeline on a schedule you choose.
4. Read `output/balances.csv`, which each balances run rewrites, or query `analytics.latest_balances` in the warehouse.
5. When the brief changes, add a source, a chain or [your own pipeline](#add-your-own-pipeline).

A new analyst should be able to get through these steps in an afternoon.

## Add your own pipeline

A **pipeline** is a mart folder plus everything it reads (sources and models), run as one Dagster job on its own cron.

1. Add mart models under `transformation/models/marts/<pipeline>/`, and any models only that pipeline needs under `transformation/models/intermediate/<pipeline>/`. Staging stays per source under `staging/<source>/`.
2. Register the name and schedule in `PIPELINES` in `orchestration/pipeline/schedules.py`.
3. If you need new raw data first, add a source (see [Add a source](docs/architecture.md#add-a-source)), then point the mart at its staging models.
4. Materialize once in Dagster (or `bj run <pipeline>`) and confirm the tests pass. The schedule runs it from then on.

Orchestration tests fail if an asset belongs to no scheduled pipeline, so nothing ships that never runs. [Add a pipeline](docs/architecture.md#add-a-pipeline) has the full steps.

## Docs

| Doc | Read it for |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Layout, data flow, CLI reference, monitoring, adding sources and pipelines |
| [GLOSSARY.md](GLOSSARY.md) | Terms: source, stream source, call, record, batch, run, dead letter |
| [transformation/README.md](transformation/README.md) | dbt models, and adding a chain to balances |

## Status

BlockJuice is in active development. For now the framework is this repository: clone it, fill in `.env` and run your own warehouse. We're working on thinner packaging for customer apps. The parts analysts touch (`name`/`table`, mart shapes, `bj`) should stay the same when it ships.
