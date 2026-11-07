# BlockJuice

![BlockJuice, a blockchain data ELT framework](docs/images/bj-banner-2.png)

A self-hosted ELT framework and warehouse for blockchain data. You can trace any number it gives you back to raw rows, and rebuild it.

If you advise funds, treasuries or protocol teams, you know where on-chain work gets awkward. Explorers are fine for a quick look. Shared analytics platforms work until you need to own the query, the join or how long the data is kept.

BlockJuice runs in your environment. It loads chain data into your Postgres, transforms it with dbt and schedules the work with Dagster. Balances, transfers, trades and labels sit next to the rest of your data, under keys and policies you set.

The result is a pipeline an analyst can read, change and hand to a client. Every step is in the repo for anyone to check.

## Why

You keep the data. Raw rows, marts, run logs and answers live in a warehouse and repo you run. When an auditor or a client asks how a number was built, you can show them the model and the run that produced it.

You can ask in plain language. The repo's [Claude Code skill](#claude-code-skill) (`/bj <question>`) maps the question onto marts, and builds any that are missing. It runs the analysis through the `bj` CLI and writes `answers/<slug>/` with the value, the checks and the method. From there it can make a PDF, a spreadsheet or a Google Doc.

Adding coverage doesn't mean building a platform. For another wallet list, EVM chain or protocol, copy a source with `bj new-source`, regenerate `sources.json`, add the chain in dbt (see [transformation/README.md](transformation/README.md)) and schedule a pipeline. The [glossary](GLOSSARY.md) explains call sources and stream sources. The shared library already handles cursors and dead letters, so you can spend your time on the question.

When something breaks, you can see it. `bj doctor` checks your env and services before you start debugging. Grafana and the `ops.*` run log show ingestion and dbt side by side. The library keeps failed calls as dead letters instead of dropping them.

## What

| You need | What ships |
|---|---|
| Point-in-time balances | ETH, ERC-20, SOL, SPL, BTC → `analytics.latest_balances` |
| Transfer history | ERC-20 on Ethereum, Arbitrum, Base → `analytics.erc20_transfers` |
| DEX activity | Uniswap v2/v3/v4 → `analytics.dex_trades` |
| Address labels | Code + exchange seeds → `analytics.address_labels` |
| Token metadata | Name, symbol and decimals of listed ERC-20 tokens on Ethereum, Arbitrum, Base → `analytics.tokens` |
| Token prices | Binance and Coinbase candles for any listed token → `analytics.token_prices`; Chainlink rounds on Ethereum, Arbitrum, Base → `analytics.oracle_prices` |
| How it runs | TypeScript extract/load → dbt → Dagster, plus Docker for the warehouse, eRPC, Dshackle and monitoring |
| How you drive it | `bj` CLI (`dev`, `doctor`, `run`, `answer`, `report`, `new-source`, …) and the blockjuice skill |

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

When Dagster is up, open http://localhost:3000 and materialize the assets you need. Then ask a question with `/bj`, or read [Ask a question](docs/architecture.md#ask-a-question) to see what the skill does and the `bj` commands behind it. If something looks wrong, run `bj doctor` before anything else.

## How you use it

1. Set up once with `bj install`, start the stack and Dagster with `bj dev`, then open the Dagster UI.
2. Point sources at the wallets and tokens you care about, in each source's `addresses.json`. A source that covers several chains keeps one per chain under `chains/<chain>/`.
3. Materialize a pipeline (balances, transfers, dex or labels) on a schedule you choose.
4. Ask the business question in Claude Code. You get an answer folder with its checks, and a report if you want one.
5. When the brief changes, add a source, a chain or [your own pipeline](#add-your-own-pipeline). The [skill](#claude-code-skill) can walk you through any of these.

A new analyst should be able to get through these steps in an afternoon.

## Claude Code skill

BlockJuice includes a Claude Code skill at `.claude/skills/blockjuice/`. Start it with `/bj` or `/blockjuice`. It lets an analyst run the stack without first learning every folder. It can:

- answer a question: scope it, find or build the marts, write a dbt analysis, run checks and write `answers/<slug>/` (`question.yaml`, `answer.json`, `answer.md`, `results/`)
- turn an answer into XLSX, PDF, Word or a Google Doc with `bj report`, using rows from your warehouse
- add a state or history source (a call source or a stream source) when the data isn't loaded yet
- add a pipeline when you need a reusable mart that no schedule builds yet
- explore a protocol, writing `catalog/protocols/<name>/` from real logs before anyone writes SQL against it

The skill runs every mechanical step through the `bj` CLI, so a person and an agent get the same checks. Answers and reports end up as files and warehouse tables you own. To see how the skill works, start at `.claude/skills/blockjuice/SKILL.md`.

## Add your own pipeline

A **pipeline** is a mart folder plus everything it reads (sources and models), run as one Dagster job on its own cron.

The easiest way to build one is to ask the [Claude Code skill](#claude-code-skill). Its new-pipeline workflow (`.claude/skills/blockjuice/workflows/new-pipeline.md`) has every step and runs them for you. To do it by hand:

1. Add mart models under `transformation/models/marts/<pipeline>/`, and any models only that pipeline needs under `transformation/models/intermediate/<pipeline>/`. Staging stays per source under `staging/<source>/`.
2. Register the name and schedule in `PIPELINES` in `orchestration/pipeline/schedules.py`.
3. If you need new raw data first, add a source (`bj new-source …`, see [Add a source](docs/architecture.md#add-a-source)), then point the mart at its staging models.
4. Materialize once in Dagster (or `bj run <pipeline>`) and confirm the tests pass. The schedule runs it from then on.

Orchestration tests fail if an asset belongs to no scheduled pipeline, so nothing ships that never runs. [Add a pipeline](docs/architecture.md#add-a-pipeline) has the full steps.

## Docs

| Doc | Read it for |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Layout, data flow, CLI reference, monitoring, adding sources and pipelines |
| [GLOSSARY.md](GLOSSARY.md) | Terms: source, stream source, call, record, batch, run, dead letter |
| [transformation/README.md](transformation/README.md) | dbt models, and adding a chain to balances |
| `.claude/skills/blockjuice/` | The skill's workflows, from question to report |

## Status

BlockJuice is in active development. For now the framework is this repository: clone it, fill in `.env` and run your own warehouse. We're working on thinner packaging for customer apps. The parts analysts touch (`name`/`table`, mart shapes, `bj`) should stay the same when it ships.
