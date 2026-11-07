# Generate a report

A report turns one answer into a file the user can share: a spreadsheet, a PDF, a Word file or a Google Doc. Every number in it comes from this repo's warehouse, through an answer in `answers/<slug>/` that anyone can rerun. There is no other path: never fill a report from memory, a block explorer or a hosted service such as Dune.

Use this workflow when the user asks for a report, a spreadsheet, a PDF or a Google Doc, or types `report <slug>`. When the answer does not exist yet, the report starts with [answer.md](answer.md).

## Inputs

| Input | Where it goes |
|---|---|
| The question | `question` in `question.yaml`, in the user's words. |
| The format: spreadsheet, PDF, Word or Google Doc | `--format xlsx`, `pdf`, `docx` or `gdoc`. With no format named, `bj report` writes `xlsx,pdf`. |
| The wallets and assets | Addresses from the repo (the `addresses.json` files, existing models) or from the user, named under `definitions`. |
| As of when, optional | `asked` and `window` in `question.yaml`: `at: latest` for now, or `from` and `to` with blocks from `bj blocks` for a past span. |

## What a report can hold today

A report reads marts only. These exist:

| Mart | Pipeline | One row is |
|---|---|---|
| `latest_balances` | `balances` | A wallet's latest balance of one asset on one chain, in base units. State: it answers "now", and `block_number` says at which block. |
| `erc20_transfers` | `transfers` | One ERC-20 transfer on Ethereum, Arbitrum or Base, named in its `chain` column: into or out of a tracked wallet, or of a tracked token on a chain that tracks no wallets. History, from `<chain>.erc20_transfers`. |
| `dex_trades` | `dex` | One Uniswap v2, v3 or v4 trade on Ethereum, in each token's base units, without prices. History, from `ethereum.uniswap_v2`, `ethereum.uniswap_v3` and `ethereum.uniswap_v4`. |
| `tokens` | `tokens` | One ERC-20 token on Ethereum, Arbitrum or Base, with its latest `name`, `symbol` and `decimals`. Join on `chain` and `token` to turn base units into whole tokens. A null `decimals` means the contract has none. |

A question these cannot answer, such as a past balance, a token price or a chain no mart covers, is not a report yet. Say which mart or source is missing and what step 2 of [answer.md](answer.md) would build, and wait for a go. Never fill the gap with data from outside the warehouse.

## Steps

1. **Clarify, at most once.** Read the question against the marts above. Ask only what changes the number or the file: an address the repo lacks, a word that could be counted two ways and whose readings differ, or as of when. Put everything into one message, before any other work. The format never needs a question: with none named, write `xlsx,pdf` and say so. When nothing is open, do not ask.

2. **Scope and answer.** Follow steps 1 to 4 of [answer.md](answer.md): write `question.yaml`, write the analyses, run `bj answer <slug>`. A report asks three things of the analyses:
   - The first analysis returns the headline as one row of one column. It becomes the report's value.
   - The second analysis, `<name>_by_<thing>.sql`, holds the breakdown the spreadsheet shows: one row per wallet, asset, transfer or trade.
   - Units are converted in SQL and named in the column, such as `eth`, with the base units in a column beside them, as `tracked_wallets_eth_by_wallet.sql` does.

   `bj answer` reads the warehouse in a read-only session and writes only `answers/<slug>/`.

3. **Check freshness.** The `freshness` detail in `answer.json` says when each input last loaded. Hold it against the user's as-of:
   - A report about "now" built on a load from days ago either says so in `answer.md` or loads newer data first: `bj run <pipeline>` (`balances`, `transfers` or `dex`), then rerun `bj answer`. A failed run leaves the last good load in place; say how old it is.
   - A window over `erc20_transfers` or `dex_trades` needs coverage: `bj coverage <chain>.<table>` shows what each source has loaded, and the `coverage` check fails when the window is outside it. [history-source.md](history-source.md) says how to extend it.
   - Dagster runs each pipeline on the cron in `PIPELINES` in `orchestration/pipeline/schedules.py`. The run log, `ops.ingestion_runs`, holds every run, and http://localhost:3000 shows them while `dagster dev` is running.

4. **Write the answer.** Step 6 of [answer.md](answer.md). The report is built from `answer.md`, so what the reader sees as the method and the as-of comes from there: the sentence with the number and its unit, "How it was counted" with the definitions in plain words, and "The data" with the marts as `analytics.<mart>`, the chains, the blocks or times, and when each input last loaded, copied from `answer.json`. Copy every number from `answer.json` and the CSVs; never retype or round them differently.

5. **Emit.**

   ```sh
   uv run --project orchestration bj report <slug> --format xlsx,pdf
   ```

   It builds each format from `answer.json`, `answer.md` and `results/`. `--format` takes any of `xlsx`, `pdf`, `docx` and `gdoc`, comma-separated. Files land in `answers/<slug>/reports/<slug>.<format>`; `gdoc` prints the Doc's URL instead. Each format holds the question, the value, when it was answered, `answer.md`, the definitions, the checks, each result and the provenance (git SHA, dbt version). The spreadsheet holds every row of each result on its own sheet; the PDF and the Word file show the first 50 rows of each and its row count. Open the PDF with the Read tool and check it before you hand it over.

## Outputs

- The file paths, or the Google Doc's URL.
- One line that says what was counted, from which mart, as of when: the value and its unit, the definition that fixes it, `analytics.<mart>`, and when the input last loaded.

## When it fails

| What happened | What to do |
|---|---|
| `bj answer` exits 2 because it cannot reach the warehouse. | The stack is down or `.env` is wrong: `docker compose up -d`, check the `WAREHOUSE_*` values, rerun. Until then there is no report. Tell the user so; never answer from anywhere else. |
| No mart holds an input. | Stop before the analysis. Name the mart or source that is missing, point at step 2 of [answer.md](answer.md), and wait for a go. |
| A result has no rows, or the value is `none`. | `none` also means the first analysis is not one row of one column. Otherwise check the filter against the source's `addresses.json`, the `freshness` detail (no successful run: `bj run`), and for history the `coverage` detail. An empty result that is right, such as no trades in the window, is the answer: say so in `answer.md` and report it. Never pad it with other data. |
| A check failed (`bj answer` exits 1). | [../references/checks.md](../references/checks.md) says what each one means. Ship the report only when the user agrees, say so in `answer.md`, and leave the failed check in the report's Checks table. |
| `--format gdoc` exits 2 asking for Google credentials, or cannot reach Google. | Write the local formats instead, `bj report <slug> --format xlsx,pdf,docx`, and hand those over; `results/*.csv` is there for a plain spreadsheet. Pass the credentials message to the user (below) and rerun with `gdoc` once they are set. |
| `bj report` says `answer.json` or `answer.md` does not exist. | Steps 2 and 4 have not run. Run them, then rerun `bj report`. |

## Rules

- Use the words in [GLOSSARY.md](../../../../GLOSSARY.md): warehouse, mart, pipeline, answer, input, check, run, coverage.
- One clarifying message at most, before any work. After it, decide, and record the reading under `definitions` and the ones passed over under `alternatives`.
- Make it plain where the data comes from. Every report names the marts it reads and when each input last loaded, and the Checks and Provenance sections stay in every format.
- To change a number or a sentence, fix `answer.md` or rerun `bj answer`, then rerun `bj report`. Never edit a report file by hand.
- Only `bj run` writes to the warehouse, through a pipeline. Nothing in this workflow writes to `raw.*` or `analytics.*` by hand.
- Git ignores `reports/`, since `bj report` rebuilds it. Give the user the file paths.

## Google Docs

`--format gdoc` uploads the report to the user's Google Drive as a Google Doc and prints its URL. A rerun updates the same Doc, whose id `reports/<slug>.gdoc.json` keeps.

It needs Google credentials in `.env`. When `bj` exits 2 asking for them, pass its message to the user. They create a Desktop OAuth client in a Google Cloud project with the Drive API on, and set `GOOGLE_OAUTH_CLIENT_SECRET` to its JSON file. The first run opens a browser for their consent, so the user runs that one themselves. `GOOGLE_DRIVE_FOLDER_ID` puts new Docs in a folder.
