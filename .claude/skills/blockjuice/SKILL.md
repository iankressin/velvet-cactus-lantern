---
name: bj
description: blockjuice. Answers questions about blockchain data by building the sources, dbt models and reports it needs in this repo. Use for any on-chain question about wallets, tokens, protocols, volumes or balances, and to turn an answer into a Google Doc, a PDF or a spreadsheet.
argument-hint: "<question> | report <slug> | source <chain> <table> | pipeline <name> | schedule <pipeline> <cron>"
---

# blockjuice

Every answer comes from the warehouse, through files in this repo that anyone can rerun. Never answer from memory, a block explorer or an MCP tool alone.

Before you build a source, a model or a pipeline, read [references/layers.md](references/layers.md). It says what each layer does: sources load raw data, and dbt does every transformation.

Pick the workflow for the request and read it:

| Request | Workflow |
|---|---|
| A question about chain data | [workflows/answer.md](workflows/answer.md) |
| `report <slug>`, or the user wants an answer as a spreadsheet, a PDF, a Word file or a Google Doc | [workflows/report.md](workflows/report.md) |
| Data that a view function or RPC method returns, which no source reads yet | [workflows/state-source.md](workflows/state-source.md) |
| Events, transfers or traces over a range of blocks that no source reads yet, or not far enough | [workflows/history-source.md](workflows/history-source.md) |
| A reusable mart that no pipeline builds yet | [workflows/new-pipeline.md](workflows/new-pipeline.md) |
| Change when a pipeline runs | [workflows/schedule-jobs.md](workflows/schedule-jobs.md) |

Never stand in state reads for history ([references/choosing-the-data.md](references/choosing-the-data.md)). A protocol with no entry in `catalog/protocols/` gets one first: [workflows/explore-protocol.md](workflows/explore-protocol.md).

## Commands

Run commands from the repo root. On a fresh checkout, run `uv run --project orchestration bj install` once: it copies the `.env` files, installs the pnpm packages `bj run` needs and writes the dbt manifest, and starts nothing. The stack must be up (`docker compose up -d`). `bj dev` also sets up and starts the stack, but then runs Dagster in the foreground, so leave it to the user.

- `uv run --project orchestration bj <command>` runs every mechanical step. It reads `.env` itself. `bj --help` lists the commands.
- dbt and Dagster read settings from the environment, so start each such command with `set -a && . ./.env && set +a &&`.

Use the words in [GLOSSARY.md](../../../GLOSSARY.md).
