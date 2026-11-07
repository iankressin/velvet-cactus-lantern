# `latest_balances` in the Take-Home's Shape Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `analytics.latest_balances` gives each wallet's latest balance of each asset under the brief's columns, `blockchain`, `wallet_address`, `token_address` and `balance_tokens`, with the balance in whole tokens.

**Architecture:** Each `int_<chain>_balances` model gains a `decimals` column that holds its native asset's decimals on native rows and null on token rows. The mart still picks one reading per chain, wallet and asset, the latest. It then left-joins `tokens` for ERC-20 and SPL decimals and scales exactly with `trim_scale(balance * power(10::numeric, -decimals))`. Only the mart's output uses the brief's names. The intermediate models keep `chain`, `wallet` and `asset`, as the other marts do. An enforced contract on the mart pins its columns, their order and their types.

**Tech Stack:** dbt-core 1.12 and dbt-postgres 1.11 on Postgres 16, Dagster with dagster-dbt 0.29, pytest.

**Spec:** `/Users/ianguimaraes/Projects/am/take-home/description.md`, the take-home brief one folder above the repo root. This plan covers its output columns and `balance_tokens`. It doesn't cover the input CSV, restricting the rows to the requested pairs, or writing the file.

## Setup

- [ ] Check that `feat/solana-spl-metadata` is merged into `main`: `git log main --oneline | grep 'solana spl metadata'` prints its commits. Without it, `tokens` has no SPL decimals.
- [ ] Create the worktree with superpowers:using-git-worktrees: branch `feat/latest-balances-shape` from `main`.
- [ ] In the worktree, run `uv run --project orchestration bj install`. It copies the `.env` files, installs the pnpm packages and runs `dbt parse`.
- [ ] Start the stack if it is down: `docker compose up -d`.
- [ ] Record the baseline:
  - `set -a && . ./.env && set +a && uv run --project orchestration dbt build --project-dir transformation --profiles-dir transformation --select +latest_balances`
  - `uv run --project orchestration pytest orchestration/tests/test_definitions.py -q`
  - `uv run --project orchestration bj answer tracked-wallets-eth` and `... bj answer tracked-wallets-sol`. Note the `value` in each `answers/<slug>/answer.json`, then run `git checkout -- answers/`.

  Note any failure that exists before you start, so no one blames it on this work.
- [ ] This plan is not committed. Read it from the main checkout at `docs/superpowers/plans/2026-11-07-latest-balances-shape.md`.

## Global Constraints

- Output columns, from the spec: "`blockchain`, `wallet_address`, `token_address`, `balance_tokens` (human-readable token units, adjusted for decimals)". These four come first, in this order.
- The spec asks for "at least these columns". After the four, the mart keeps `asset_type`, `decimals`, `balance` (base units) and `block_number`, so each number traces back to its reading. **This is the planner's call and is open for the user to confirm.**
- Chains and assets, from the spec: "Ethereum: Native ETH and ERC-20 tokens", "Solana: Native SOL and SPL tokens", "Bitcoin: Native BTC". `asset_type` is `native`, `erc20` or `spl`.
- `token_address` is null for a native asset, matching an input line whose `token_address` is empty. Otherwise it holds the ERC-20 contract or the SPL mint.
- Native decimals: ETH 18, SOL 9, BTC 8.
- `balance_tokens = trim_scale(balance * power(10::numeric, -decimals))`. Never divide: in Postgres, `1234567890123456789012345678 / power(10::numeric, 18)` returns `1234567890.12345679` and drops 10 digits. Multiplying stays exact for every decimals value from 0 to 255, and `trim_scale` cuts trailing zeros (`1.5`, not `1.500000`).
- Unknown decimals give null `decimals` and null `balance_tokens`, and the row stays. Never assume 18.
- Address case: Ethereum is lowercased in staging, and `tokens.token` is too. Solana and Bitcoin keep their case (base58), and the join compares them exactly.
- The grain doesn't change: one row per chain, wallet and asset ever loaded, holding the latest reading. A tie on block goes to the reading loaded last.
- Run commands from the repo root. Start every dbt command with `set -a && . ./.env && set +a &&` and call dbt as `uv run --project orchestration dbt <command> --project-dir transformation --profiles-dir transformation`. The `dbt …` lines below leave out that prefix and those flags.
- Dagster tests read `transformation/target/manifest.json`, so run `dbt parse` before pytest after any change to a `ref`.
- Prose in SQL comments, YAML descriptions and docs: short words, active voice, no stock phrases.

## Review Focus

1. A balance with more than 16 significant digits, such as a whale's ETH in wei. Every digit should survive. Test: Task 2, unit-test row `0xw1`/`eth`.
2. A token missing from the metadata sources' `addresses.json`. The row should stay, with null `balance_tokens`, and a warning should name the token. Test: Task 2, unit-test row `0xnometa`, plus the `balance_tokens` warn test.
3. A zero balance should read `0`, not `0E-18` or `0.000000000000000000`. Test: Task 2, unit-test SOL row, and the trailing-zero data test.
4. A native row should have an empty `token_address`, never `eth`, `sol` or `btc`. Test: Task 2, unit-test native rows, and the `not_null` test on `token_address` with its `where`.
5. A token with 0 decimals should give `balance_tokens = balance`, not null. Test: Task 2, unit-test row `0xzero`.

## Out of Scope

- Reading the input CSV, limiting the mart to the requested pairs, echoing the input's address case, and writing the output CSV.
- Adding the input's tokens to the metadata sources' `addresses.json`. Until that happens, those tokens show up in the `balance_tokens` warning.
- EIP-55 checksum case for Ethereum addresses. Postgres has no keccak.
- Renaming `chain` and `token` in the other marts.

## File Structure

- Modify `transformation/models/intermediate/balances/int_{ethereum,solana,bitcoin}_balances.sql`: add `decimals`.
- Modify `transformation/models/intermediate/balances/_int_{ethereum,solana,bitcoin}__models.yml`: add `decimals` to each contract.
- Modify `transformation/models/marts/balances/latest_balances.sql`: the new shape.
- Modify `transformation/models/marts/balances/_balances__models.yml`: the contract, the column tests and the unit test.
- Modify `transformation/tests/latest_balances_one_row_per_wallet_asset.sql`: the new key columns.
- Create `transformation/tests/latest_balances_balance_tokens_has_no_trailing_zeros.sql`.
- Modify `transformation/analyses/tracked_wallets_{eth,sol}.sql` and `tracked_wallets_{eth,sol}_by_wallet.sql`: the new columns.
- Modify `orchestration/tests/test_definitions.py`: `tokens` becomes a parent of `latest_balances`.
- Modify `transformation/README.md`, `docs/architecture.md` and `.claude/skills/blockjuice/workflows/report.md`: describe the change.

---

### Task 1: Native decimals in the int balance models

**Files:**
- Modify: `transformation/models/intermediate/balances/int_ethereum_balances.sql`, `int_solana_balances.sql`, `int_bitcoin_balances.sql`
- Modify: `transformation/models/intermediate/balances/_int_ethereum__models.yml`, `_int_solana__models.yml`, `_int_bitcoin__models.yml`
- Modify: `transformation/README.md` (`## Adding a chain`, step 1), `docs/architecture.md` (the paragraph that lists the shape `int_<chain>_balances` brings)

**Interfaces:**
- Consumes: nothing new.
- Produces: each `int_<chain>_balances` has `decimals integer` between `asset` and `block_number`. It holds 18, 9 or 8 on native rows and null on `erc20` and `spl` rows.

- [ ] **Step 1: Add the column to each contract**

In each `_int_<chain>__models.yml`, after `asset`:

```yaml
      - name: decimals
        data_type: integer
        description: The native asset's decimals on native rows; null on token rows, whose decimals latest_balances takes from tokens.
```

- [ ] **Step 2: Run the build and check that it fails**

Run: `dbt build --select int_ethereum_balances int_solana_balances int_bitcoin_balances`
Expected: FAIL. Each model's contract names `decimals` as missing.

- [ ] **Step 3: Add `decimals` to each model's select, after `asset`**

`int_ethereum_balances`: `18 as decimals` on the ETH branch, `null::integer as decimals` on the ERC-20 branch. `int_solana_balances`: `9` on SOL, `null::integer` on SPL. `int_bitcoin_balances`: `8`. Update each model's header comment.

- [ ] **Step 4: Run the build and check that it passes**

Run: `dbt build --select int_ethereum_balances int_solana_balances int_bitcoin_balances latest_balances`
Expected: PASS. `latest_balances` doesn't read the new column yet, so it builds unchanged.

- [ ] **Step 5: Update the docs**

`transformation/README.md`, step 1 of `## Adding a chain`: the new model sets `decimals` to its native asset's decimals on native rows and to null on token rows. `docs/architecture.md`: add `decimals` to the list of columns that `int_<chain>_balances` brings.

- [ ] **Step 6: Commit**

```bash
git add transformation/models/intermediate/balances transformation/README.md docs/architecture.md
git commit -m "feat(balances): carry native decimals in the int balance models" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `latest_balances` in the brief's shape

**Files:**
- Modify: `transformation/models/marts/balances/latest_balances.sql`, `_balances__models.yml`
- Modify: `transformation/tests/latest_balances_one_row_per_wallet_asset.sql`
- Create: `transformation/tests/latest_balances_balance_tokens_has_no_trailing_zeros.sql`
- Modify: `transformation/analyses/tracked_wallets_eth.sql`, `tracked_wallets_eth_by_wallet.sql`, `tracked_wallets_sol.sql`, `tracked_wallets_sol_by_wallet.sql`
- Modify: `orchestration/tests/test_definitions.py:28-45`
- Modify: `docs/architecture.md` (the `analytics.latest_balances` sentences), `transformation/README.md` (`## Adding a chain`, step 3), `.claude/skills/blockjuice/workflows/report.md` (the `latest_balances` row)

**Interfaces:**
- Consumes: `decimals` on each `int_<chain>_balances` (Task 1); `ref('tokens')` with `chain`, `token` and `decimals`, one row per chain and token.
- Produces: `analytics.latest_balances` with the columns in Step 1, in that order.

- [ ] **Step 1: Write the contract and column tests in `_balances__models.yml`**

Add `config: contract: enforced: true` and these columns, in this order:

| Column | `data_type` | Tests |
|---|---|---|
| `blockchain` | text | `not_null`; `accepted_values` `[ethereum, solana, bitcoin]` |
| `wallet_address` | text | `not_null` |
| `token_address` | text | `not_null` with `config: where: "asset_type <> 'native'"` |
| `balance_tokens` | numeric | `not_null` with `config: severity: warn` |
| `asset_type` | text | `not_null`; `accepted_values` `[native, erc20, spl]` |
| `decimals` | integer | none |
| `balance` | numeric | `not_null` |
| `block_number` | bigint | `not_null` |

The model description says what one row is, that `token_address` is null for the native asset, and that `balance_tokens` is null when the decimals are unknown. The `balance_tokens` description says the warning lists tokens that are missing from the metadata sources.

- [ ] **Step 2: Write the unit test in `_balances__models.yml`**

Use `format: sql` throughout, so YAML never parses a large number as a float.

```yaml
unit_tests:
  - name: latest_balances_scales_each_latest_balance_by_its_decimals
    model: latest_balances
    given:
      - input: ref('int_ethereum_balances')
        format: sql
        rows: |
          select 'e1' as id, 'ethereum' as chain, '0xw1' as wallet, 'native' as asset_type, 'eth' as asset, 18 as decimals, 100::bigint as block_number, 1234567890123456789012345678::numeric as balance, '2026-11-07 00:00+00'::timestamptz as _loaded_at
          union all select 'e2', 'ethereum', '0xw1', 'erc20', '0xusdc', null, 100, 1500000, '2026-11-07 00:00+00'
          union all select 'e3', 'ethereum', '0xw1', 'erc20', '0xnometa', null, 100, 42, '2026-11-07 00:00+00'
          union all select 'e4', 'ethereum', '0xw2', 'native', 'eth', 18, 100, 5, '2026-11-07 00:00+00'
          union all select 'e5', 'ethereum', '0xw2', 'native', 'eth', 18, 101, 1, '2026-11-07 00:00+00'
          union all select 'e6', 'ethereum', '0xw2', 'native', 'eth', 18, 101, 2000000000000000000, '2026-11-07 01:00+00'
          union all select 'e7', 'ethereum', '0xw3', 'erc20', '0xzero', null, 100, 7, '2026-11-07 00:00+00'
      - input: ref('int_solana_balances')
        format: sql
        rows: |
          select 's1' as id, 'solana' as chain, 'SoLWaLLet1' as wallet, 'native' as asset_type, 'sol' as asset, 9 as decimals, 300::bigint as block_number, 0::numeric as balance, '2026-11-07 00:00+00'::timestamptz as _loaded_at
          union all select 's2', 'solana', 'SoLWaLLet1', 'spl', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', null, 300, 2500000, '2026-11-07 00:00+00'
      - input: ref('int_bitcoin_balances')
        format: sql
        rows: |
          select 'b1' as id, 'bitcoin' as chain, 'bc1qexample' as wallet, 'native' as asset_type, 'btc' as asset, 8 as decimals, 900::bigint as block_number, 150000000::numeric as balance, '2026-11-07 00:00+00'::timestamptz as _loaded_at
      - input: ref('tokens')
        format: sql
        rows: |
          select 'ethereum' as chain, '0xusdc' as token, 'USD Coin' as name, 'USDC' as symbol, 6 as decimals, 100::bigint as block_number
          union all select 'ethereum', '0xzero', 'Zero', 'ZERO', 0, 100
          union all select 'solana', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'USD Coin', 'USDC', 6, 300
    expect:
      format: sql
      rows: |
        select 'ethereum' as blockchain, '0xw1' as wallet_address, null::text as token_address, 1234567890.123456789012345678::numeric as balance_tokens, 'native' as asset_type, 18 as decimals, 1234567890123456789012345678::numeric as balance, 100::bigint as block_number
        union all select 'ethereum', '0xw1', '0xusdc', 1.5, 'erc20', 6, 1500000, 100
        union all select 'ethereum', '0xw1', '0xnometa', null, 'erc20', null, 42, 100
        union all select 'ethereum', '0xw2', null, 2, 'native', 18, 2000000000000000000, 101
        union all select 'ethereum', '0xw3', '0xzero', 7, 'erc20', 0, 7, 100
        union all select 'solana', 'SoLWaLLet1', null, 0, 'native', 9, 0, 300
        union all select 'solana', 'SoLWaLLet1', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 2.5, 'spl', 6, 2500000, 300
        union all select 'bitcoin', 'bc1qexample', null, 1.5, 'native', 8, 150000000, 900
```

`0xw2` covers both rules for picking the latest reading: block 101 beats block 100, and on block 101 the row loaded at 01:00 beats the one loaded at 00:00.

- [ ] **Step 3: Write the two singular tests**

`latest_balances_one_row_per_wallet_asset.sql`: group by `blockchain, wallet_address, token_address`. Postgres groups nulls together, so a wallet's native row still counts once.

`latest_balances_balance_tokens_has_no_trailing_zeros.sql` fails on any row where `balance_tokens::text ~ '\.[0-9]*0$'`. The unit test can't catch trailing zeros, because numeric equality treats `1.5` and `1.50` as the same.

- [ ] **Step 4: Point `test_definitions.py` at the new parent**

In `test_mart_reads_each_chain_through_its_intermediate_model`, the expected parents of `latest_balances` become the three int models plus `dg.AssetKey("tokens")`.

- [ ] **Step 5: Run the tests and check that they fail**

Run: `dbt build --select latest_balances`
Expected: FAIL. The unit test fails on the missing `blockchain` column, or the contract names the columns that are missing.

- [ ] **Step 6: Rewrite `latest_balances.sql`**

- Keep the `union all` of the three int models, now with `decimals`.
- Pick the latest reading per `chain, wallet, asset` as today (`distinct on`, `block_number desc, _loaded_at desc`), before any join, so `tokens` can never change which reading wins.
- Then left-join `ref('tokens')` on `asset_type <> 'native' and tokens.chain = chain and tokens.token = asset`. Decimals are `coalesce(<int decimals>, tokens.decimals)`.
- Select the columns in Step 1's order. `token_address` is `case when asset_type = 'native' then null else asset end`. `balance_tokens` is the expression in Global Constraints.
- Rewrite the header comment: one row is a wallet's latest reading of one asset on one chain, in base units and in whole tokens. `token_address` is null for the native asset. `balance_tokens` is null when the decimals are unknown.

- [ ] **Step 7: Run the tests and check that they pass**

Run: `dbt build --select latest_balances`
Expected: PASS. The `balance_tokens` warn test may warn on real data. Its list should name only tokens missing from the metadata sources' `addresses.json`.

Run: `dbt parse`, then `uv run --project orchestration pytest orchestration/tests/test_definitions.py -q`
Expected: PASS.

- [ ] **Step 8: Move the analyses to the new columns**

Filter on `blockchain`. Replace `balance / 1e18` and `balance / 1e9` with `balance_tokens`, keeping each `round(…, n)`. In the `_by_wallet` analyses, select `wallet_address as wallet`, so the result columns (`wallet`, `block_number`, `eth`/`sol`, `wei`/`lamports`) and the answer CSV headers stay the same.

Run: `uv run --project orchestration bj answer tracked-wallets-eth` and `... bj answer tracked-wallets-sol`
Expected: each `answer.json` `value` equals the baseline from Setup. Then run `git checkout -- answers/`, so no new numbers get committed.

- [ ] **Step 9: Update the docs**

- `docs/architecture.md`: `analytics.latest_balances` holds `balance_tokens` next to `balance` and names its columns `blockchain`, `wallet_address` and `token_address`. Token decimals come from `tokens`. The `balances` job now also runs `tokens` and its metadata sources.
- `transformation/README.md`, step 3 of `## Adding a chain`: add the chain to the `accepted_values` of `blockchain`.
- `.claude/skills/blockjuice/workflows/report.md`, the `latest_balances` row: in base units and in whole tokens (`balance_tokens`); join on `blockchain`, `wallet_address` and `token_address`.

- [ ] **Step 10: Commit**

```bash
git add transformation/models/marts/balances transformation/tests transformation/analyses orchestration/tests/test_definitions.py docs/architecture.md transformation/README.md .claude/skills/blockjuice/workflows/report.md
git commit -m "feat(balances): give latest_balances the take-home's columns and balance_tokens" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## End-to-End Check

This needs eRPC and Dshackle up, since it reads the chains.

- [ ] Run `uv run --project orchestration bj run balances`. The run now includes `tokens` and the metadata ingestion.
- [ ] `dbt show --inline "select blockchain, token_address from {{ ref('latest_balances') }} where balance_tokens is null"` lists only tokens missing from the `addresses.json` of `evm-erc20-metadata` and `solana-spl-metadata`.
- [ ] `dbt show --inline "select * from {{ ref('latest_balances') }} where asset_type = 'erc20' limit 3"`: work out `balance / 10^decimals` by hand for one row and compare it with `balance_tokens`. Do the same for one `spl` row and one native row on each chain.
