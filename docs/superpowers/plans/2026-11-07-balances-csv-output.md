# The Balances CSV Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `bj run balances` writes `output/balances.csv`, with one row per wallet and asset that `input/wallet-assets.csv` asks for, and with the brief's columns first.

**Architecture:** A new source, `input-wallet-assets`, loads every line of the input file into `raw.input_wallet_assets`, under a new load id on each run. Each line keeps its cells as written, the normalized wallet and token (the keys the balance tables use), and its problem if the line is invalid. The balance sources skip invalid lines with a warning instead of failing. A new mart, `requested_balances`, takes the newest load, counts each pair once, and left-joins `latest_balances`. A Dagster asset, `balances_csv`, runs after the mart in the `balances` job and writes the mart to a file.

**Tech Stack:** TypeScript on Node 24 in the pnpm workspace in `ingestion/`, zod 4, `node:test` run by tsx; dbt-core 1.12 and dbt-postgres 1.11 on Postgres 16; Dagster with dagster-dbt, psycopg2, pytest.

**Spec:** the brief, `/Users/ianguimaraes/Projects/am/take-home/description.md`, one folder above the repo root, and the decisions from the 2026-11-07 design talk, listed under Decisions below. Background: `docs/superpowers/handoffs/2026-11-07-balances-csv-output.md`. Its item 4 (a fresh warehouse fails) went away when #6 removed the transfers tests, and Task 7 checks that it stays gone.

## Setup

- [ ] Create the worktree with superpowers:using-git-worktrees: branch `feat/balances-csv` from `main`.
- [ ] In the worktree, run `uv run --project orchestration bj install`. It copies the root `.env` and each source's `.env`, installs the pnpm packages and runs `dbt parse`.
- [ ] Give the worktree its own warehouse. Stop any other checkout's stack first, since every stack binds `localhost:5432`. Then run `docker compose up -d` from the worktree's folder.
- [ ] Build a subset input at `input/subset.csv`, and never commit it. Take the header; 3 Bitcoin lines; 4 Ethereum wallets with their ETH line and 1 to 2 ERC-20 lines each; 4 Solana wallets with their SOL line and 1 to 2 SPL lines each. Every line must be valid and distinct: Task 7 adds the bad ones.
- [ ] Point every source at it: in the root `.env`, set `WALLET_ASSETS_CSV=../../../input/subset.csv`. The path is from a source's package folder. Under `bj` and Dagster, the root `.env` wins over each source's own.
- [ ] Load the raw tables once, since a fresh warehouse has none and dbt fails without them: `uv run --project orchestration bj run balances`.
- [ ] Record the baseline:
  - `cd ingestion && pnpm typecheck && pnpm -r test`
  - `uv run --project orchestration pytest orchestration/tests -q`

  Expect one failure: `env.test.ts`, "the default path ... reaches a file", because `input/wallet-assets.csv` moved in `3808d52`. Task 1 fixes it. Note any other failure, so no one blames it on this work.
- [ ] This plan isn't committed. Read it from the main checkout at `docs/superpowers/plans/2026-11-07-balances-csv-output.md`.

## Decisions

The user approved these on 2026-11-07:

- The CSV comes out of the pipeline: sources load, dbt transforms, and the file is written from a mart built on `latest_balances`. No standalone CLI.
- The request list reaches the warehouse through an ingestion source, not a dbt seed. The input lives in one file, read by the balance sources and the loader alike.
- A bad input line no longer fails its balance source. The source skips the line and warns. The loader records the line, and the CSV reports it as `invalid_input`. A file-level problem (missing file, bad header, BOM, no rows) still fails the run.
- When this run couldn't read a pair, the CSV shows the last good reading, with its `block_number` and `read_at`. There is no `stale` status.
- A Dagster asset writes the file in the `balances` job. There is no `bj export` command.

These are the planner's calls, open for the user to change:

- The source is `name: "input"`, `table: "wallet_assets"`, package `input-wallet-assets`. Its raw table is `raw.input_wallet_assets`, and its staging model is `stg_input__wallet_assets`.
- The mart is `requested_balances`.
- `input_line` is the CSV's last column. Rows sort by it.
- The CSV goes to `output/balances.csv` by default, set by `BALANCES_CSV_PATH`, from the repo root. The output from the full run is committed there as the example output. The untracked `examples/wallet-assets.csv`, a byte-for-byte copy of `input/wallet-assets.csv`, is deleted.

## Global Constraints

- CSV columns, in this order: `blockchain, wallet_address, token_address, balance_tokens, status, block_number, read_at, input_line`. The first four are the brief's ("`blockchain`, `wallet_address`, `token_address`, `balance_tokens` (human-readable token units, adjusted for decimals)").
- `blockchain`, `wallet_address` and `token_address` come as written in the input. An empty `token_address` stays empty.
- `status` is one of `ok`, `unknown_decimals`, `no_reading`, `invalid_input`.
- One row per distinct pair, compared by normalized key: chain, normalized wallet, normalized token. A repeated pair keeps its first line. Each invalid line keeps its own row, since it has no key.
- Only the newest load of the input counts. A pair that the newest load doesn't ask for is not in the CSV, even when `latest_balances` holds it.
- Join the native asset with `is not distinct from` on the token, so a native request never matches a token reading.
- Keep numbers exact. Never pass a balance through a float, and never divide to scale one. Write `Decimal` with `format(value, "f")`, through `cell_text` in `orchestration/pipeline/cli/answer.py`.
- Write empty cells for nulls, and `\n` line endings, as `bj answer` does.
- The input file is `input/wallet-assets.csv`. From a source's package folder, its path is `../../../input/wallet-assets.csv`.
- Run commands from the repo root. Start every dbt command with `set -a && . ./.env && set +a &&` and call dbt as `uv run --project orchestration dbt <command> --project-dir transformation --profiles-dir transformation`. The `dbt …` lines below leave out that prefix and those flags.
- Run `dbt parse` before pytest after any change to a `ref`. The Dagster tests read `transformation/target/manifest.json`.
- Test on a subset of about 20 wallets, never the full file, until Task 8. The full file spends eRPC's upstream budgets.
- Prose in comments, YAML descriptions and docs: short words, active voice, no stock phrases.

## Review Focus

1. An Ethereum address in checksum case in the input. The CSV should echo it as written, and the join should still find the lowercased reading. Test: Task 5, unit-test lines 2 and 3.
2. A bad line in the input. The run should still write the CSV, with the line marked `invalid_input`. Tests: Task 2, the reader warns instead of throwing; Task 5, unit-test lines 8 and 9; Task 7, the end-to-end run.
3. A native request for a wallet that holds only token readings. It should show `no_reading`, never a token's balance. Test: Task 5, unit-test line 6.
4. A run that fails while writing the file. The previous CSV should stay whole, with no half-written file. Test: Task 6, `test_a_failed_write_keeps_the_previous_file`.
5. A pair dropped from the input since the last run. It should leave the CSV, though `latest_balances` still holds it. Test: Task 5, unit-test load `L1`.

## Out of Scope

- The leftovers from #5's review (handoff item 6).
- A `stale` status, which would need each raw row to record the run that wrote it.
- Removing `WALLET_ASSETS_CSV` from each source's `.env.example`. Task 1 only documents that the root `.env` can set it for all of them.
- A `bj export` command.

## File Structure

- Modify `ingestion/lib/src/wallet-assets/env.ts`, `env.test.ts`: the default input path.
- Modify `ingestion/lib/src/wallet-assets/wallet-assets.ts`, `wallet-assets.test.ts`, `index.ts`: classify every line; reads skip bad lines.
- Modify the `source.test.ts` of the seven sources that read the input: a bad line no longer fails the run.
- Create `ingestion/sources/input-wallet-assets/` (`package.json`, `.env.example`, `src/source.ts`, `src/index.ts`, `src/source.test.ts`), and regenerate `ingestion/sources.json`.
- Create `transformation/models/staging/input/_input__sources.yml`, `_input__models.yml`, `stg_input__wallet_assets.sql`.
- Modify `transformation/models/marts/balances/latest_balances.sql`, `_balances__models.yml`: add `read_at`.
- Create `transformation/models/marts/balances/requested_balances.sql`; modify `_balances__models.yml`: its contract, tests and unit test.
- Create `orchestration/pipeline/assets/balances_csv.py`, `orchestration/tests/test_balances_csv.py`.
- Modify `orchestration/pipeline/schedules.py`, `definitions.py`, `orchestration/tests/test_definitions.py`.
- Modify `.env.example`, `docs/architecture.md`, `README.md`.
- Create `output/balances.csv` (Task 8).

---

### Task 1: Point the default input path at `input/`

**Files:**
- Modify: `ingestion/lib/src/wallet-assets/env.ts`, `ingestion/lib/src/wallet-assets/env.test.ts`
- Modify: `ingestion/sources/bitcoin-btc-balances/src/source.test.ts` (the test "reads the shared wallet asset CSV unless WALLET_ASSETS_CSV says otherwise" pins the old default)
- Modify: `.env.example`

**Interfaces:**
- Produces: `walletAssetsEnv.parse({})` returns `{ WALLET_ASSETS_CSV: "../../../input/wallet-assets.csv" }`.

- [ ] **Step 1: Update the tests.** In `env.test.ts`, rename the first test to "points a source at input/wallet-assets.csv unless WALLET_ASSETS_CSV says otherwise" and expect `{ WALLET_ASSETS_CSV: "../../../input/wallet-assets.csv" }`. Leave the second test as it is: it already resolves the default from `sources/bitcoin-btc-balances/` and fails today. In the Bitcoin source test, expect the new default too.

- [ ] **Step 2: Run them to see them fail.**
Run: `cd ingestion && pnpm exec tsx --test lib/src/wallet-assets/env.test.ts && pnpm --filter @ingestion/bitcoin-btc-balances test`
Expected: FAIL in both `env.test.ts` tests and in the Bitcoin test.

- [ ] **Step 3: Change the default** in `env.ts` to `"../../../input/wallet-assets.csv"`, and fix its doc comment, which still names `ingestion/wallet-assets.csv`.

- [ ] **Step 4: Run them to see them pass.** Same command. Expected: PASS.

- [ ] **Step 5: Document the shared setting.** In the root `.env.example`, after `LOG_LEVEL`, add:

```sh
# The wallet asset CSV that the balance, metadata and input sources read, by its path from a source's
# package folder. Set here, it points every source at one file: under bj and Dagster it wins over each
# source's own .env.
# WALLET_ASSETS_CSV=../../../input/wallet-assets.csv
```

- [ ] **Step 6: Commit.**

```bash
git add ingestion/lib/src/wallet-assets/env.ts ingestion/lib/src/wallet-assets/env.test.ts ingestion/sources/bitcoin-btc-balances/src/source.test.ts .env.example
git commit -m "fix(lib): point the default wallet asset CSV at input/"
```

### Task 2: Classify every line; reads skip bad lines

**Files:**
- Modify: `ingestion/lib/src/wallet-assets/wallet-assets.ts`, `wallet-assets.test.ts`, `index.ts`
- Modify: `source.test.ts` in `bitcoin-btc-balances`, `evm-eth-balances`, `evm-erc20-balances`, `evm-erc20-metadata`, `solana-sol-balances`, `solana-spl-balances`, `solana-spl-metadata`

**Interfaces:**
- Produces, exported from `@ingestion/lib/wallet-assets`:

```ts
/** One line of the wallet asset CSV: its cells as written, and the wallet asset it names or why it names none. */
export type WalletAssetLine = {
  line: number;
  /** The cells as written. A missing cell is "". */
  blockchain: string;
  walletAddress: string;
  tokenAddress: string;
  /** Null exactly when `problems` is not empty. */
  asset: WalletAsset | null;
  problems: string[];
};

/** Every line of the file, repeats included, in file order. Throws only for a problem with the whole file. */
export function parseWalletAssetLines(text: string, file: string): WalletAssetLine[];
export function readWalletAssetLines(path: string): WalletAssetLine[];
```

- `parseWalletAssets` and `readWalletAssets` keep their signatures. They no longer throw for bad lines.

- [ ] **Step 1: Write the failing tests** in `wallet-assets.test.ts`.
  - Replace "fails only the read whose rows are bad, listing each problem by line" with "skips the bad rows of a read and warns with each problem by line". With `withBadRows` and a warning collector:
    - `read("ethereum", "native")` returns `[ethNative]` and warns once: `'Invalid ethereum native rows in wallets.csv, skipped:\n  line 3: wallet_address "0x123" is not an Ethereum address'`.
    - `read("ethereum", "erc20")` returns `[]` and warns with lines 4, 4 and 5, with the same problem texts as today's test.
    - `read("solana", "spl")` returns `[]` and warns about line 7. `read("solana", "native")` returns `[solNative]` and doesn't warn.
    - `read("bitcoin")` returns `[]` and warns about lines 8, 9 and 10.
  - Add "lists every line with its cells as written, and its wallet asset or its problems". `parseWalletAssetLines(csv(...))` on these lines:
    - `ethereum,${vitalik},` gives `{ line: 2, blockchain: "ethereum", walletAddress: vitalik, tokenAddress: "", asset: ethNative, problems: [] }`. The wallet keeps its case; `asset` holds it lowercased.
    - `ethereum,0x123,` gives `asset: null` and `problems: ['wallet_address "0x123" is not an Ethereum address']`.
    - `bitcoin,${btcWallet}` gives `tokenAddress: ""` and `problems: ["has 2 cells; the header has 3"]`.
    - `Ethereum,${vitalik},` gives `problems: ['blockchain "Ethereum" is not ethereum, solana or bitcoin']`.
    - A repeat of the first line appears again, with its own line number.

- [ ] **Step 2: Run them to see them fail.**
Run: `cd ingestion && pnpm exec tsx --test lib/src/wallet-assets/wallet-assets.test.ts`
Expected: FAIL. `parseWalletAssetLines` is not exported, and the reads throw.

- [ ] **Step 3: Implement.** `parseWalletAssetLines` runs `parseCsv`, then gives each row its problems: an unknown chain, or what `problemsWith` finds, and `walletAssetOf` when there are none. Rebuild `parseWalletAssets` on it. Keep the unknown-chain warning and the repeat warning as they are. Replace the `throw` with one `warn` call: `` `Invalid ${read} rows in ${file}, skipped:\n${problems}` ``. Keep `picks`, so a token line on Bitcoin still reaches every Bitcoin read. Export the new names from `index.ts`.

- [ ] **Step 4: Run them to see them pass.** Same command. Expected: PASS.

- [ ] **Step 5: Update the seven source tests.** Each has a test named "a bad … row fails the run, not the import", and the Bitcoin file also has "a Bitcoin row with a token fails the run". Replace each with "… is skipped, and the run reads the rest": a CSV with one good line and the bad line. Assert that the first batch's calls cover the good line only. Use what each file's other tests already check: the records from its fake RPC, or, in the Bitcoin file, the failed calls against its unreachable Dshackle. Keep the tests for a missing column and for a bad `addresses.json`: those still fail the run.

- [ ] **Step 6: Run every ingestion test and the typecheck.**
Run: `cd ingestion && pnpm typecheck && pnpm -r test`
Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add ingestion/lib/src/wallet-assets ingestion/sources/*/src/source.test.ts
git commit -m "feat(lib): skip bad wallet asset rows with a warning, and list every line with its problems"
```

### Task 3: `latest_balances` gains `read_at`

**Files:**
- Modify: `transformation/models/marts/balances/latest_balances.sql`, `_balances__models.yml`

**Interfaces:**
- Produces: `analytics.latest_balances.read_at timestamptz`, the last column: the `_loaded_at` of the reading that won.

- [ ] **Step 1: Update the unit test's expectation.** In `latest_balances_scales_each_latest_balance_by_its_decimals`, add `read_at` to every expected row. Every reading loaded at `'2026-11-07 00:00+00'`, except `0xw2`'s winner, `e6`, which loaded at `'2026-11-07 01:00+00'`. Add the column to the contract: `read_at`, `data_type: timestamptz`, `not_null`, described as "When the source loaded this reading, within a minute of when it read it."

- [ ] **Step 2: Run it to see it fail.**
Run: `dbt build --select latest_balances`
Expected: FAIL, because the model lacks `read_at`.

- [ ] **Step 3: Implement.** Carry `_loaded_at` through the `latest` and `scaled` CTEs, and select `_loaded_at as read_at` last.

- [ ] **Step 4: Run it to see it pass.** Same command. Expected: PASS, with the unit test and every data test.

- [ ] **Step 5: Commit.**

```bash
git add transformation/models/marts/balances
git commit -m "feat(balances): give latest_balances the time each reading loaded"
```

### Task 4: The `input-wallet-assets` source

**Files:**
- Create: `ingestion/sources/input-wallet-assets/package.json`, `.env.example`, `src/source.ts`, `src/index.ts`, `src/source.test.ts`
- Modify: `ingestion/sources.json` (generated)
- Create: `transformation/models/staging/input/_input__sources.yml`, `_input__models.yml`, `stg_input__wallet_assets.sql`

**Interfaces:**
- Consumes: `readWalletAssetLines`, `walletAssetsEnv` (Tasks 1 and 2).
- Produces: `export const inputWalletAssets: Source<WalletAssetsEnv, never>` with `name: "input"`, `table: "wallet_assets"`, `call: z.never()`. Each run yields one batch, `{ records, failed: [] }`, with one record per line:
  - `id` and `callId`: `` `${loadId}:${line}` ``, where `loadId` is a new `randomUUID()` per run.
  - `data`: `{ load_id, line, blockchain, wallet_address, token_address, asset_type, wallet, token, problem }`. The cells come as written. `asset_type`, `wallet` and `token` come from `asset`, and are null when it is null. A native asset has a null `token`. `problem` joins `problems` with `"; "`, and is null when there are none.
- Produces: `stg_input__wallet_assets`, a view over every load, with columns `id, load_id, line (integer), blockchain, wallet_address, token_address, asset_type, wallet, token, problem, _loaded_at`.

- [ ] **Step 1: Create the package.** Copy the shape of `bitcoin-btc-balances`: `package.json` named `@ingestion/input-wallet-assets`, with `ingest` and `test` scripts and dependencies `@ingestion/lib` and `zod`. `.env.example` holds the warehouse settings, `RAW_SCHEMA`, `WALLET_ASSETS_CSV=../../../input/wallet-assets.csv`, `PUSHGATEWAY_URL` and `LOG_LEVEL`, as that package's does. `src/index.ts` calls `runSource(inputWalletAssets)`.

- [ ] **Step 2: Write the failing tests** in `src/source.test.ts`, with a temp CSV as the other source tests use:
  - "loads every line, valid or not, under one load id". Use the lines `ethereum,${vitalik},`, `ethereum,0x123,`, `ethereum,0x456,ETH`, `Ethereum,${vitalik},`, and `ethereum,${vitalik},` again. Expect five records and no failed calls, with ids `${loadId}:2` to `${loadId}:6` under one `loadId`. Line 2's data is `{ load_id, line: 2, blockchain: "ethereum", wallet_address: vitalik, token_address: "", asset_type: "native", wallet: vitalik.toLowerCase(), token: null, problem: null }`. Line 4's `problem` holds both of its problems, joined by `"; "`. Line 6 repeats line 2 and is still loaded.
  - "gives each run a new load id": two runs give different `load_id`s.
  - "a CSV without a token_address column fails the run": it rejects with the `parseCsv` message, as the Solana source tests do.

- [ ] **Step 3: Run them to see them fail.**
Run: `cd ingestion && pnpm install && cd sources/input-wallet-assets && pnpm test`
Expected: FAIL, because `src/source.ts` doesn't exist.

- [ ] **Step 4: Implement `src/source.ts`.** Read the file inside `extract`, not at import, so `runSource` reports a bad file.

- [ ] **Step 5: Run them to see them pass.** Same command. Expected: PASS.

- [ ] **Step 6: Regenerate `sources.json`.**
Run: `cd ingestion && pnpm --silent generate-sources && git diff sources.json`
Expected: one new entry, `{ "name": "input", "table": "wallet_assets", "package": "input-wallet-assets" }`.

- [ ] **Step 7: Add the dbt source and staging model.**
  - The source `input`, with schema `{{ env_var('RAW_SCHEMA', 'raw') }}`, table `wallet_assets` and identifier `input_wallet_assets`. Test `id` with `unique` and `not_null`, as the other sources do.
  - `stg_input__wallet_assets.sql` reads `data ->> '…'` for each field and casts `line` to integer. Keep every load: picking the newest is the mart's job.
  - Tests: `id` unique and not_null; `load_id`, `line` and `blockchain` not_null; `asset_type` in `[native, erc20, spl]`; `wallet` not_null where `asset_type is not null`; `problem` not_null where `asset_type is null`.

- [ ] **Step 8: Load once and build the staging model.**
Run: `uv run --project orchestration bj install` (it copies the new package's `.env`), then `set -a && . ./.env && set +a && (cd ingestion/sources/input-wallet-assets && pnpm --silent ingest)`, then `dbt build --select stg_input__wallet_assets`.
Expected: the source logs one batch with as many records as `input/subset.csv` has lines below its header. dbt passes.

- [ ] **Step 9: Run the Dagster tests.**
Run: `dbt parse && uv run --project orchestration pytest orchestration/tests -q --deselect orchestration/tests/test_definitions.py::test_every_asset_and_check_runs_in_a_scheduled_pipeline`
Expected: PASS. The new source's parametrized tests pass. The deselected test fails until Task 5 puts the new asset under a mart in the `balances` job. Check that it fails for that reason alone: its diff names only `input/wallet_assets`, `stg_input__wallet_assets` and their checks.

- [ ] **Step 10: Commit.**

```bash
git add ingestion/sources/input-wallet-assets ingestion/sources.json ingestion/pnpm-lock.yaml transformation/models/staging/input
git commit -m "feat(input): load every line of the wallet asset CSV into the warehouse"
```

### Task 5: The `requested_balances` mart

**Files:**
- Create: `transformation/models/marts/balances/requested_balances.sql`
- Modify: `transformation/models/marts/balances/_balances__models.yml`
- Modify: `orchestration/tests/test_definitions.py`

**Interfaces:**
- Consumes: `stg_input__wallet_assets` (Task 4), `latest_balances.read_at` (Task 3).
- Produces: `analytics.requested_balances`, with an enforced contract, and columns in the order the Global Constraints give: `blockchain text, wallet_address text, token_address text, balance_tokens numeric, status text, block_number bigint, read_at timestamptz, input_line integer`.

- [ ] **Step 1: Write the unit test** `requested_balances_gives_each_requested_pair_one_row`.

Given `ref('stg_input__wallet_assets')`. Load `L1` (`_loaded_at` `'2026-11-06 06:00+00'`) has one line: line 2, `ethereum`, `0xOLD`, native, wallet `0xold`. Load `L2` (`'2026-11-07 06:00+00'`) has these lines:

| line | blockchain | wallet_address | token_address | asset_type | wallet | token | problem |
|---|---|---|---|---|---|---|---|
| 2 | ethereum | 0xAbC | | native | 0xabc | null | null |
| 3 | ethereum | 0xAbC | 0xUSDC | erc20 | 0xabc | 0xusdc | null |
| 4 | ethereum | 0xabc | 0xnometa | erc20 | 0xabc | 0xnometa | null |
| 5 | ethereum | 0xabc | 0xreverted | erc20 | 0xabc | 0xreverted | null |
| 6 | solana | SoLWaLLet1 | | native | SoLWaLLet1 | null | null |
| 7 | bitcoin | BC1QEXAMPLE | | native | bc1qexample | null | null |
| 8 | ethereum | 0x123 | | null | null | null | wallet_address "0x123" is not an Ethereum address |
| 9 | ethereum | 0x123 | | null | null | null | wallet_address "0x123" is not an Ethereum address |
| 10 | ethereum | 0xABC | | native | 0xabc | null | null |

Given `ref('latest_balances')`, columns `blockchain, wallet_address, token_address, balance_tokens, asset_type, decimals, balance, block_number, read_at`:

| blockchain | wallet_address | token_address | balance_tokens | block_number | read_at |
|---|---|---|---|---|---|
| ethereum | 0xabc | null | 2 | 101 | 2026-11-07 06:01+00 |
| ethereum | 0xabc | 0xusdc | 1.5 | 101 | 2026-11-07 06:01+00 |
| ethereum | 0xabc | 0xnometa | null | 101 | 2026-11-07 06:01+00 |
| ethereum | 0xold | null | 1 | 90 | 2026-11-06 06:01+00 |
| solana | SoLWaLLet1 | EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v | 2.5 | 300 | 2026-11-07 06:01+00 |
| bitcoin | bc1qexample | null | 1.5 | 900 | 2026-11-05 06:01+00 |

Fill `asset_type`, `decimals` and `balance` to fit each row. Expect exactly:

| blockchain | wallet_address | token_address | balance_tokens | status | block_number | read_at | input_line |
|---|---|---|---|---|---|---|---|
| ethereum | 0xAbC | null | 2 | ok | 101 | 2026-11-07 06:01+00 | 2 |
| ethereum | 0xAbC | 0xUSDC | 1.5 | ok | 101 | 2026-11-07 06:01+00 | 3 |
| ethereum | 0xabc | 0xnometa | null | unknown_decimals | 101 | 2026-11-07 06:01+00 | 4 |
| ethereum | 0xabc | 0xreverted | null | no_reading | null | null | 5 |
| solana | SoLWaLLet1 | null | null | no_reading | null | null | 6 |
| bitcoin | BC1QEXAMPLE | null | 1.5 | ok | 900 | 2026-11-05 06:01+00 | 7 |
| ethereum | 0x123 | null | null | invalid_input | null | null | 8 |
| ethereum | 0x123 | null | null | invalid_input | null | null | 9 |

What the test pins: load `L1` and the `0xold` reading are absent. Line 10 repeats line 2 and is absent. Line 6 doesn't take the SPL reading. Line 7 keeps an old reading, with its `read_at`.

- [ ] **Step 2: Write the contract and data tests** in `_balances__models.yml`: `input_line` unique and not_null; `status` not_null and in `[ok, unknown_decimals, no_reading, invalid_input]`; `blockchain` and `wallet_address` not_null; `balance_tokens` not_null where `status = 'ok'`. Each column's description says where its value comes from.

- [ ] **Step 3: Run them to see them fail.**
Run: `dbt build --select requested_balances`
Expected: FAIL, because the model doesn't exist.

- [ ] **Step 4: Implement `requested_balances.sql`.**
  - The newest load is the `load_id` of the row with the greatest `_loaded_at`.
  - Valid lines (`asset_type is not null`) keep the first line of each `(blockchain, wallet, token)`. Use `row_number()`, since it treats a null `token` as one value. Invalid lines all stay.
  - Left-join `latest_balances` on `blockchain`, `wallet_address = wallet` and `token_address is not distinct from token`.
  - `token_address` is `nullif(token_address, '')`, from the line as written.
  - `status` is `invalid_input` when `asset_type` is null, then `no_reading` when no reading joined, then `unknown_decimals` when `balance_tokens` is null, and otherwise `ok`.

- [ ] **Step 5: Run them to see them pass.** Same command. Expected: PASS.

- [ ] **Step 6: Update the Dagster tests.**
  - In `test_balances_job_ingests_the_balances_and_every_source_tokens_reads`, add `dg.AssetKey(["input", "wallet_assets"])`, and add a line to its comment: `requested_balances` reads the input list.
  - Add `test_requested_balances_joins_the_input_to_latest_balances`: the parents of `requested_balances` are exactly `{stg_input__wallet_assets, latest_balances}`.

- [ ] **Step 7: Run every Dagster test.**
Run: `dbt parse && uv run --project orchestration pytest orchestration/tests -q`
Expected: PASS, including `test_every_asset_and_check_runs_in_a_scheduled_pipeline`.

- [ ] **Step 8: Commit.**

```bash
git add transformation/models/marts/balances orchestration/tests/test_definitions.py
git commit -m "feat(balances): add requested_balances, one row per requested wallet asset"
```

### Task 6: The `balances_csv` asset

**Files:**
- Create: `orchestration/pipeline/assets/balances_csv.py`, `orchestration/tests/test_balances_csv.py`
- Modify: `orchestration/pipeline/schedules.py`, `orchestration/pipeline/definitions.py`, `orchestration/tests/test_definitions.py`, `.env.example`

**Interfaces:**
- Consumes: `analytics.requested_balances` (Task 5); `cell_text` from `pipeline.cli.answer`; `connect` from `pipeline.warehouse`; `REPO_ROOT` from `pipeline.project`.
- Produces:
  - `csv_path() -> Path`: `REPO_ROOT / os.environ.get("BALANCES_CSV_PATH", "output/balances.csv")`. An absolute setting stays absolute.
  - `write_csv(path: Path, columns: Sequence[str], rows: Iterable[Sequence[Any]]) -> int`: writes the header, then each row through `cell_text`, with `csv.writer(file, lineterminator="\n")`, to a temp file in the same folder. Then it renames the temp file over `path` with `os.replace`. It creates missing folders, and returns the row count.
  - The asset `balances_csv`: `@dg.asset(key="balances_csv", deps=[dg.AssetKey("requested_balances")], group_name="output", kinds={"csv"})`. It runs `select * from <DBT_SCHEMA>.requested_balances order by input_line` (with `DBT_SCHEMA` defaulting to `analytics`, quoted with `psycopg2.sql.Identifier`), takes the header from `cursor.description`, and calls `write_csv`. It returns `dg.MaterializeResult` with metadata `path`, `rows`, and one count per `status`.

- [ ] **Step 1: Write the failing tests** in `test_balances_csv.py`:
  - `test_writes_the_header_then_each_row_exactly`. Columns `["blockchain", "wallet_address", "token_address", "balance_tokens", "read_at", "input_line"]`, rows `("ethereum", "0xAbC", None, Decimal("1234567890.123456789012345678"), datetime(2026, 11, 7, 6, 1, tzinfo=timezone.utc), 2)` and `("ethereum", "0xAbC", "0xUSDC", Decimal("0.000000000000000001"), None, 3)`. It returns 2, and the file reads exactly `"blockchain,wallet_address,token_address,balance_tokens,read_at,input_line\nethereum,0xAbC,,1234567890.123456789012345678,2026-11-07T06:01:00Z,2\nethereum,0xAbC,0xUSDC,0.000000000000000001,,3\n"`.
  - `test_creates_missing_folders`: `tmp_path / "a" / "b" / "balances.csv"` exists after a write.
  - `test_a_failed_write_keeps_the_previous_file`: the path holds `"old\n"`, and the rows are a generator that yields one row, then raises `RuntimeError`. `write_csv` raises, the path still reads `"old\n"`, and the folder holds no other file.
  - `test_csv_path_defaults_to_output_balances_csv` (with `BALANCES_CSV_PATH` unset), and `test_csv_path_reads_balances_csv_path`: a relative setting resolves under `REPO_ROOT`, and an absolute one stays as it is.
- In `test_definitions.py`, add `test_balances_csv_reads_requested_balances_in_the_balances_job`: the parents of `balances_csv` are `{AssetKey("requested_balances")}`, and the `balances` job's selection holds `balances_csv`.

- [ ] **Step 2: Run them to see them fail.**
Run: `uv run --project orchestration pytest orchestration/tests/test_balances_csv.py orchestration/tests/test_definitions.py -q`
Expected: FAIL, because the module doesn't exist.

- [ ] **Step 3: Implement** `balances_csv.py`. Register the asset in `definitions.py`. In `schedules.py`, give the `balances` job `dg.AssetSelection.assets(balances_csv)` next to its dbt selection, through a mapping from pipeline name to the assets it writes after its marts.

- [ ] **Step 4: Run them to see them pass.**
Run: `dbt parse && uv run --project orchestration pytest orchestration/tests -q`
Expected: PASS, including `test_every_asset_and_check_runs_in_a_scheduled_pipeline`.

- [ ] **Step 5: Add the setting** to the root `.env.example`, after the `WALLET_ASSETS_CSV` comment from Task 1:

```sh
# Where the balances job writes its CSV, from the repo root.
BALANCES_CSV_PATH=output/balances.csv
```

- [ ] **Step 6: Commit.**

```bash
git add orchestration/pipeline orchestration/tests .env.example
git commit -m "feat(balances): write requested_balances to a CSV after each balances run"
```

### Task 7: Docs, and a run on a fresh warehouse

**Files:**
- Modify: `docs/architecture.md`, `README.md`

- [ ] **Step 1: Update the docs.**
  - `docs/architecture.md`, the balances paragraph. The input is `input/wallet-assets.csv`. A bad line no longer fails a source: each source skips it with a warning. Add a sentence each on the `input-wallet-assets` source, `requested_balances` and `balances_csv`.
  - `README.md`, the table of what each pipeline produces: add a row for `output/balances.csv`, from `analytics.requested_balances`.

- [ ] **Step 2: Add bad lines to the subset.** Append `ethereum,0x123,` and a copy of one Ethereum line to `input/subset.csv`. Count its lines below the header as `N`. The root `.env` still points every source at it, from Setup.

- [ ] **Step 3: Empty the worktree's warehouse.** From the worktree's folder, confirm that `docker compose ls` names this worktree's project, then run `docker compose down -v && docker compose up -d`.

- [ ] **Step 4: Run the job.**
Run: `time uv run --project orchestration bj run balances`
Expected: `balances: run … succeeded`, and the exit code is 0. The logs of the Ethereum native read show the warning about `0x123`.

- [ ] **Step 5: Check the file.**
  - `head -1 output/balances.csv` prints `blockchain,wallet_address,token_address,balance_tokens,status,block_number,read_at,input_line`.
  - `tail -n +2 output/balances.csv | wc -l` prints `N - 1`, since the repeat drops out.
  - The `0x123` line has status `invalid_input`. Every Ethereum address appears in the case the subset file uses.
  - `cut -d, -f5 output/balances.csv | sort | uniq -c` shows mostly `ok`. Explain every `no_reading` and `unknown_decimals` row, for example a dead letter, by looking in `raw._dead_letters`.
  - Check one ETH balance against the chain. Run `eth_getBalance` through `http://localhost:4000/main/evm/1` for one wallet, at the row's `block_number`. Scaled by 10^18, it equals `balance_tokens`.

- [ ] **Step 6: Clean up.** Remove the `WALLET_ASSETS_CSV` line from the root `.env`, delete `input/subset.csv`, and delete `output/balances.csv`. A subset's output is not the example.

- [ ] **Step 7: Commit the docs.**

```bash
git add docs/architecture.md README.md
git commit -m "docs: describe the input loader, requested_balances and the balances CSV"
```

### Task 8: The full run, the example output and PR #3's markers

Ask the user before Step 1. The full file spends eRPC's upstream budgets.

- [ ] **Step 1: Run the full file.**
Run: `time uv run --project orchestration bj run balances`
Expected: success. Note the wall time for `TODO(run-time)`.

- [ ] **Step 2: Check the output.** It has one row per distinct pair in `input/wallet-assets.csv`, plus one per invalid line, and its status counts match the asset's metadata in Dagster. Explain every row that isn't `ok`, as in Task 7.

- [ ] **Step 3: Remove the copy, and commit the example output.** Run `cmp examples/wallet-assets.csv input/wallet-assets.csv`, which should print nothing. Then delete `examples/`.

```bash
git add output/balances.csv
git commit -m "docs: add the balances CSV from a full run as the example output"
```

- [ ] **Step 4: Fill PR #3's markers** on the `docs/take-home-readme` branch, after this branch merges. Fill each `TODO(csv-out)` in `TAKE-HOME.md`. The command is `uv run --project orchestration bj run balances`. The output path is `output/balances.csv`, and the example input is `input/wallet-assets.csv`. Give the columns in order, one line on each, from the Global Constraints. When decimals are unknown, `balance_tokens` is empty and `status` is `unknown_decimals`. Fill `TODO(run-time)` with the time from Step 1.
