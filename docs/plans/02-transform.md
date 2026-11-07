# Transform — implementation plans

**Owner:** BJ Transform  
**Baseline:** `main` after PR #1 and #2  
**Mode:** plans only

## 1) Merge PR #2 — DONE

[PR #2](https://github.com/iankressin/block-juice/pull/2) (lowercase Ethereum addresses in staging) is **merged** (`d24b6c4`). Quality Gate PASS.

Post-merge (optional): from a fresh worktree off `main`, run `dbt build` and confirm reconciliation, grain, and pool tests; remove `framework-worktrees/address-case` when clean.

Solana and Bitcoin addresses stay out of scope (base58 is case-sensitive).

## 2) Enforce contracts on DEX intermediates — PR E

**Goal:** `int_ethereum_uniswap_v{2,3,4}_trades` get the same enforced column contracts as the balances models, so a shape change fails loudly before it reaches `dex_trades`.

**Files:** `transformation/models/intermediate/.../_int_dex__models.yml` (and related model SQL if needed).

**Steps:** Each model declares the same columns and types as the `dex_trades` column list, plus `not_null` on the keys. Amounts stay plain `numeric`.

**Verification:** `dbt build`; deliberate column-rename test that should fail the build.

**Risks:** Low. Local Mac worktree preferred.

**Out of scope:** Multi-chain transfers; inventing new DEX features.

**Dependencies:** None — can start when Ian says go on implementation.

## 3) Multi-chain `erc20_transfers` — later / blocked

**Shape only until a second EVM transfers source exists.**

Each chain gets an `int_<chain>_erc20_transfers` model with identical, contracted columns; the mart is a `union all` with `accepted_values` on `chain`. Reconciliation test and `erc20_balance_pairs` keyed by chain.

**Dependencies:** BJ Ingestion adding that chain’s transfers source.

**Recommended order:** #1 done → #2 (PR E) → #3 later.
