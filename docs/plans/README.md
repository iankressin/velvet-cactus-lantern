# BlockJuice implementation plans (docs only)

These documents capture the specialist implementation **plans** for the ranked backlog. They are not code.

Baseline: `main` @ `d24b6c4` (after PR #1 and PR #2).

| File | Owner |
|------|--------|
| [00-consolidated-pr-brief.md](./00-consolidated-pr-brief.md) | BJ Team Lead |
| [01-quality-gate-name-contract.md](./01-quality-gate-name-contract.md) | BJ Quality Gate |
| [02-transform.md](./02-transform.md) | BJ Transform |
| [03-skills-and-reports.md](./03-skills-and-reports.md) | BJ Skills & Reports |
| [04-ingestion.md](./04-ingestion.md) | BJ Ingestion |
| [05-orchestration.md](./05-orchestration.md) | BJ Orchestration |
| [06-decimals.md](./06-decimals.md) | Take-home |
| [07-csv-output.md](./07-csv-output.md) | Take-home |
| [08-example-input-and-run.md](./08-example-input-and-run.md) | Take-home |

### Take-home balances CSV

Plans 06 to 08 produce the take-home's balances CSV through the pipeline. Ingestion sources fetch and load, dbt builds `requested_balances` in `marts/balances/`, and the `balances_csv` Dagster asset writes the file in the `balances` job. The CSV-input plan is not written yet. These requests wait on it:

- Load the input as a dbt seed, `transformation/seeds/requested_assets.csv`, with columns `line, blockchain, wallet_address, token_address`. Set `column_types` to text and `line` to integer in `_seeds.yml`. Keep every input line, bad ones too, with cells as written and an empty `token_address` for natives. (06, 07)
- Name the load step and its input path setting, next to `BALANCES_CSV_PATH`. The example run uses it on a smoke file and on the full file. (07, 08)
- Write the CSV's Ethereum tokens into `addresses.json` of both `evm-erc20-balances` and `evm-erc20-metadata`, and its mints into both `solana-spl-balances` and `solana-spl-metadata`. (06, 08)
- Put a wallet in a token list only if it asks for a token there. Keep bad addresses out of every source list. (07, 08)
- Optional. Let the SPL source read requested pairs instead of every wallet against every mint, which cuts the example's 810 calls to 340. It changes the source's input. (08)

**Do not implement A–H until Ian says go after this docs PR.** Prefer local Mac worktrees when cloud agent credits are blocked. Quality Gate reviews before merge-ready.
