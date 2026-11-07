# Ingestion — implementation plans

**Owner:** BJ Ingestion  
**Checked against:** `iankressin/block-juice` `main` @ `d24b6c49`  
**Mode:** plans only

### Notes from main

- 9 sources. `ethereum-uniswap-v2/v3/v4` are all `StreamSource`.
- `main` still uses `ERPC_URL` everywhere (0 hits for `EVM_RPC_URL` / `SOLANA_RPC_URL`); Ian’s local checkout may have an uncommitted rename — implement PR D from clean `origin/main`.
- `bj new-source` copies a live package (no template dir).
- `ethereum-eth-balances` still has no `balances.test.ts`.
- `TODOs.md` still lists “Support for BTC” (BTC balances source already exists — clarify separately).

Also owns (PR A, with Orchestration/QG): `ingestion/scripts/generate-sources-json.ts` + committed `ingestion/sources.json`. Generator must import each package’s side-effect-free `src/source.ts` only — **never** `src/index.ts` (calls `runSource` on import). Every source must export its `Source` from `source.ts`.

---

## PLAN 1: Call-source checklist + eth-balances test parity — PR C

**Goal:** Write down the call-source contract for consultants, and give `ethereum-eth-balances` the same `balances.test.ts` coverage its peers have.

**Files:** `README.md` “Add a source” (new subsection); new `ingestion/sources/ethereum-eth-balances/src/balances.test.ts`; optionally one line in next-steps in `orchestration/pipeline/cli/new_source.py` (Orchestration owns). Not `GLOSSARY.md` for the checklist (terms only). No new `ingestion/README.md`.

**Checklist:** zod call schema on the Source; failed call’s id = success record’s `callId`; extract merges retries (`[...newCalls, ...retry]`); `addresses.json` loads inside extract, not at import; `name` and `table` match dbt and Dagster.

**Steps:** (1) README subsection; (2) eth test modeled on erc20-balances but faking `eth_getBalance` — success at pinned block, transport failure → failed, duplicate calls deduped, id/callId = `` `${block}:${wallet}` ``; (3) optional CLI pointer; (4) stream scaffolds use `--like ethereum-erc20-transfers` or a Uniswap source.

**Tests:** `pnpm test` in ethereum-eth-balances; `source.test.ts` stays green.

**Risks:** wording that only fits balances (keep generic “call source”); CLI line is Orchestration’s.

**Out of scope:** shared balance kit, stream templates, GLOSSARY rewrites for the checklist itself.

**Dependencies:** none. If Plan 2 lands first, write the test with `EVM_RPC_URL`.

---

## PLAN 2: Rename `ERPC_URL` → `EVM_RPC_URL` / `SOLANA_RPC_URL` — PR D

**Goal:** Chain-specific RPC env names, consistent with Bitcoin’s `DSHACKLE_URL`. **Hard cut**, no `ERPC_URL` fallback (fallback hides half-migrated `.env` files; Quality Gate fails partial renames).

**Files (all 16 `ERPC_URL` hits on main):** `ingestion/lib/src/evm/env.ts`, `evm/client.ts`, `evm/client.test.ts`, `solana/env.ts`; `.env.example` in ethereum-eth-balances, ethereum-erc20-balances, solana-sol-balances, solana-spl-balances; `source.test.ts` in the same four; `src/source.ts` in solana-sol-balances and solana-spl-balances; `README.md` (monitoring); `orchestration/tests/test_cli_new_source.py` (fixture).

**Leave alone:** `ERPC_PORT`, `ERPC_METRICS_PORT`, `ERPC_CACHE_DATABASE_URL`; `PORTAL_URL`; `DSHACKLE_URL`; `new_source.py` (no hit). No Dagster/compose env override on main for this.

**Steps:** Rename EVM → `EVM_RPC_URL`, Solana → `SOLANA_RPC_URL`. Keep example URLs (`/main/evm/1` vs `/main/solana`). After PR, `rg --hidden ERPC_URL ingestion orchestration README.md` must find no matches; historical references under `docs/plans/` remain unchanged. PR body tells consultants to update gitignored `ingestion/sources/*/.env`.

**Tests:** ingestion/lib + four balance packages; `test_cli_new_source.py`; typecheck.

**Risks:** stale local `.env` fails with “Invalid environment” (intended); local uncommitted rename must not drift from the PR.

**Out of scope:** renaming eRPC product or its ports; Bitcoin naming.

**Dependencies:** land before or alongside Plan 1.

---

## PLAN 3: Document batch vs stream failure handling — PR C (docs)

**Goal:** Consultants shouldn’t expect dead letters from stream sources.

**Verified on main:** call sources retry through dead letters (`run/index.ts`), `MAX_ATTEMPTS=5`, parking on schema mismatch. Stream sources: `warehouse/stream.ts` always returns `failed: []`; cursor in `<schema>._sync` commits in same transaction as the batch; `maxBlocksPerRun` defaults to 1e6; thrown error fails the run; next run resumes from last committed cursor.

**Files:** `GLOSSARY.md` (Stream source / Dead letter: dead letters apply to call sources only); `README.md` “Add a source” stream paragraph (4–6 lines, plus how to reset by deleting the `_sync` row); optionally one sentence of JSDoc on `StreamSource` in `ingestion/lib/src/source.ts`.

**Tests:** docs only; existing stream and run tests stay green.

**Risks:** overpromising delivery guarantees; keep docs short.

**Out of scope:** adding dead letters to stream sources; any behavior change.

**Dependencies:** none. Same README section as Plan 1 → one docs pass can cover both.

---

**Ownership:** Ingestion owns all three. The CLI next-steps line is Orchestration’s.
