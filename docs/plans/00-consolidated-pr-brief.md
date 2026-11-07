# Consolidated implementation PR brief — BlockJuice

**For:** Ian Guimarães  
**From:** BJ Team Lead  
**Date:** 2026-11-05 (America/Sao_Paulo)  
**Repo:** github.com/iankressin/block-juice @ `main` d24b6c4 (after PR #1 + #2)  
**Mode:** Docs-only PR — specialist plans + this brief. **No implementation code.** Hold A–H until Ian says go after this lands.  
**Execution:** Prefer local git worktrees on Ian’s Mac (`~/Projects/am/framework-worktrees/…`) while cloud agent credits are blocked. Quality Gate reviews before merge-ready.

---

## Title (umbrella)

**BlockJuice: sources contract, consultant setup, ingestion clarity, DEX contracts, and skills**

Ship as **worktree PRs** (one concern per PR), not one mega-PR. Dependencies below are binding; the sections are not a strict serial order, and independent work may proceed in parallel.

---

## Already done (do not re-plan)

| Item | Status |
|------|--------|
| PR #1 balance contracts + `latest_balances` docs | Merged |
| PR #2 lowercase Ethereum addresses in staging | Merged (d24b6c4). QG PASS. Transform post-merge: optional `dbt build` from fresh worktree; remove `framework-worktrees/address-case` when clean. |

---

## Cross-layer decisions (Team Lead)

1. **`sources.json` ownership split** — Ingestion owns generator script + committed `ingestion/sources.json`. Orchestration owns Dagster load + `bj new-source` hook + CLI next-step → Transform “Adding a chain”. Quality Gate owns freshness / drift tests (and human gate on source PRs). Ingestion did not propose the generator in their three plans; treat generator as **Ingestion-owned add-on** coordinated with Orchestration PR A.
2. **`ERPC_URL` rename** — Hard cut, one PR, no fallback. Ian’s Mac checkout has an **uncommitted** rename; implement from clean `origin/main` and discard/reconcile local drift so the PR is the source of truth.
3. **README “Add a source”** — One docs pass can cover Ingestion checklist + stream failure notes; Orchestration updates any “edit SOURCES by hand” lines in the same era as PR A.
4. **`bj doctor` after `sources.json`** — Doctor’s source list comes from `sources.json`; do not ship doctor first.
5. **Skills** — Generate report can ship anytime. New pipeline soft-ships now, hard-refresh after PR A. Schedule jobs after New pipeline.

---

## Workstreams and dependency order

### PR A — `sources.json` + name-contract (highest priority)

**Owners:** Ingestion (generator + JSON) · Orchestration (Dagster + CLI) · Quality Gate (freshness/drift tests + review) · Transform (docs target only)

**Goal:** One committed list of each source’s exported `name`/`table` (not folder names). Dagster `SOURCES` built from it. Tests fail if stale. CLI regenerates instead of appending. Next-step points at Transform “Adding a chain”; mart + `PIPELINES` stay manual.

**Files**
- New: `ingestion/scripts/generate-sources-json.ts`, `ingestion/sources.json`
- Edit: `ingestion/package.json` (`generate-sources` script)
- Edit: `orchestration/pipeline/assets/ingestion.py` (load JSON; `package` → package dir)
- Edit: `orchestration/pipeline/cli/new_source.py` (call generator; next-step → `transformation/README.md` `## Adding a chain`; state mart/`PIPELINES` are hand steps)
- Edit: README lines that say add to `SOURCES` by hand
- Tests: update `orchestration/tests/test_cli_new_source.py`; add `test_sources_json_is_fresh`, `test_sources_json_package_dirs_exist`; keep package/staging/scheduled-pipeline tests

**Verification:** First JSON matches today’s 9 sources (incl. uniswap_v2/v3/v4). `bj new-source` regenerates JSON. Deliberate drift fails with named pair. QG PASS checklist: exported name/table (not dirs); no hand `SOURCES`; no false “mart/PIPELINES automatic” claims.

**Ingestion constraints (locked):**
- Generator imports each package’s side-effect-free `src/source.ts` only — **never** `src/index.ts` (that calls `runSource` on import). Every source on `main` must export its `Source` from `source.ts`; Ingestion verifies.
- Freshness test regenerates into temp and **fails on any diff** vs committed `sources.json` (same check QG enforces).

**Risks:** Generator needs `pnpm install`; import by shape (export names inconsistent); must not import `index.ts`.

**Out of scope:** Auto mart / `PIPELINES`; folder renames.

**Deps:** None. Unblocks doctor, New pipeline skill hard-refresh, QG name-contract.

---

### PR B — `bj doctor` preflight

**Owner:** Orchestration (reads Ingestion `.env.example`s)

**Goal:** One command: root `.env`, per-source `.env` (optional `--copy-env`), required keys by **name only**, ports, warehouse, eRPC/Dshackle health, tool versions. Never print secrets.

**Files:** New `orchestration/pipeline/cli/doctor.py`, `orchestration/tests/test_cli_doctor.py`; register in `cli/__init__.py`; README “Run it locally” one-liner.

**Checks (summary):** root `.env` FAIL if missing; source `.env` WARN / `--copy-env` copy-from-example never overwrite; keys from `.env.example` FAIL if missing (names only); ports 5432/4000/4001/8545/8082/3001/9090/9091/3000; warehouse via `pipeline.warehouse.connect`; eRPC `GET :4000/healthcheck` (verify); Dshackle `GET :8082/health`; Node 24 + pnpm 10.17.0 vs `mise.toml`; `uv` present WARN if missing. Exit 0/1/2 like other `bj` commands.

**Verification:** pytest set listed by Orchestration (root env, warn missing source env, copy-env, missing keys without values, erpc healthcheck path) with HTTP/warehouse mocked.

**Risks:** eRPC 502 until upstreams up → WARN during startup; health URLs assume compose defaults.

**Out of scope:** Starting compose; fixing keys; validating RPC key beyond reachability.

**Deps:** **After PR A** (`sources.json`).

---

### PR C — Call-source checklist + `ethereum-eth-balances` test parity (+ failure docs)

**Owner:** Ingestion (optional CLI pointer line → Orchestration)

**Goal:** Document call-source contract; give eth-balances `balances.test.ts` parity; document that stream sources do not use dead letters.

**Files**
- `README.md` “Add a source” (checklist + short stream failure / `_sync` reset)
- New `ingestion/sources/ethereum-eth-balances/src/balances.test.ts`
- `GLOSSARY.md` (Stream source / Dead letter: dead letters = call sources only)
- Optional: JSDoc on `StreamSource` in `ingestion/lib/src/source.ts`
- Optional: one next-steps line in `new_source.py` (Orchestration owns)

**Checklist content:** zod call schema; failed call id = success `callId`; extract merges `[...newCalls, ...retry]`; `addresses.json` inside extract not import; name/table match dbt+Dagster.

**Verification:** `pnpm test` in ethereum-eth-balances; `source.test.ts` green; docs-only for stream section.

**Risks:** balances-only wording (keep generic “call source”); same README section as PR A era — coordinate merge order.

**Out of scope:** Shared balance kit; stream templates; stream dead-letter behavior.

**Deps:** Independent of A/B; PR D must land before or alongside C. Prefer **same docs pass** as failure docs (Ingestion Plan 3).

---

### PR D — Atomic `ERPC_URL` → `EVM_RPC_URL` / `SOLANA_RPC_URL`

**Owner:** Ingestion · Quality Gate (FAIL partial / FAIL fallback)

**Goal:** Chain-specific RPC env names (like `DSHACKLE_URL`). Hard cut. After merge `rg ERPC_URL` = 0 (excluding `ERPC_PORT` / `ERPC_METRICS_PORT` / `ERPC_CACHE_DATABASE_URL`).

**Files (16 hits on main):** `ingestion/lib/src/evm/env.ts`, `evm/client.ts`, `evm/client.test.ts`, `solana/env.ts`; `.env.example` + `source.test.ts` for eth/erc20/sol/spl balances; sol `source.ts` ×2; README monitoring; `orchestration/tests/test_cli_new_source.py`. Leave `PORTAL_URL`, `DSHACKLE_URL`, compose eRPC service ports.

**Verification:** lib + four packages tests; `test_cli_new_source.py`; typecheck. PR body: consultants must update gitignored `ingestion/sources/*/.env`.

**Risks:** Stale local `.env` → Invalid environment (intended). Reconcile Ian’s uncommitted local rename with this PR.

**Out of scope:** Renaming eRPC product / ports; Bitcoin naming.

**Deps:** Independent of A/B; before or with C. QG reviews as atomic.

---

### PR E — DEX intermediate contracts

**Owner:** Transform

**Goal:** Enforce contracts on `int_ethereum_uniswap_v{2,3,4}_trades` in `_int_dex__models.yml` matching `dex_trades` column set; negative rename test.

**Verification:** `dbt build`; deliberate column-rename fails build. Amounts stay plain `numeric`.

**Out of scope:** Multi-chain transfers (blocked).

**Deps:** None — can start now in a local worktree.

---

### PR F — Generate report skill

**Owner:** Skills & Reports · Quality Gate (glossary / no Dune / no invented numbers)

**Goal:** Warehouse question → GDoc/PDF/Spreadsheet from owned marts (`latest_balances`, `erc20_transfers`, `dex_trades`). Outline ready → `UpdateSkill` on go.

**Verification:** Dry-run one balances Q → local spreadsheet; QG language check.

**Out of scope:** Historical SQD/RPC; token prices; writing raw.*; new pipelines.

**Deps:** None (warehouse up; Google connectors optional with local fallback).

---

### PR G — New pipeline + Schedule jobs skills

**Owner:** Skills & Reports (pair Orchestration on wording)

**Goal:** New pipeline: lead with `bj new-source`, then explicit hand steps (staging shape, mart / Adding a chain, `PIPELINES`). Schedule: edit `PIPELINES` in `schedules.py` only; reload Dagster; Grafana proof. Never claim mart/`PIPELINES` automatic.

**Deps:** Soft-ship New pipeline anytime; **hard-refresh after PR A**. Schedule after New pipeline in the flow.

---

### PR H — Compose health checks + Prometheus alerts

**Owner:** Orchestration (Ingestion owns metric names in `metrics.ts`)

**Goal:** Healthchecks for eRPC (`/healthcheck` :4000) and Dshackle (`/health` :8082); Prometheus rules for failed/stale runs + upstream errors; prefer Grafana alerting over new Alertmanager for v1.

**Files:** `infra/docker-compose.yml`, `infra/prometheus/prometheus.yml` (+ `rule_files`), new `infra/prometheus/alerts.yml`, README Monitoring note.

**Alerts (from pushed metrics):** `ingestion_last_run_success == 0`; stale `time() - ingestion_last_success_timestamp_seconds > 90000`; eRPC error rates; Dshackle availability / fail totals (confirm labels on live scrape).

**Verification:** `docker compose up -d prometheus`; `/-/healthy` + Rules page; QG metric names match `metrics.ts`.

**Risks:** Distroless images (no curl/wget → TCP fallback); eRPC 502 flap; no CI for rule syntax.

**Out of scope:** Alertmanager / PagerDuty / Slack; changing eRPC healthCheck config; SQL-based alerts.

**Deps:** Independent of A–G; can parallel after A if desired. Prefer after B so doctor + health story align.

---

### Later / blocked (do not start)

| Item | Owner | Blocker |
|------|--------|---------|
| Multi-chain `erc20_transfers` | Transform (+ Ingestion source) | Needs 2nd EVM transfers source |
| TODOs.md: historical SQD/RPC, token metadata/prices | — | Product backlog, not this bundle |
| BTC “Support for BTC” in TODOs.md | — | BTC balances source already exists; clarify TODOs separately |

---

## Suggested parallelization on Ian’s Mac

```
worktree A: bj/sources-json          → PR A
worktree E: bj/dex-contracts         → PR E (parallel)
worktree D: bj/erpc-rename           → PR D (start independently; before or alongside C)
worktree C: bj/batch-checklist-docs  → PR C (after or alongside D)
worktree B: bj/doctor                → PR B (after A merges)
worktree H: bj/health-alerts         → PR H (anytime after A preferred)
skills:     UpdateSkill locally      → F then G (G refresh after A)
```

Cloud agents: only if credits restored; otherwise these worktrees.

---

## Global out of scope

- Inventing product features beyond agreed backlog  
- Asof GTM work  
- Opening/merging code without Ian + Quality Gate  
- Auto-scaffolding marts / `PIPELINES`  
- Stream dead letters  
- Partial `ERPC_URL` renames  

---

## Status / approvals

1. Ordered bundle A→H + later — **documented in this PR (docs only)**.  
2. Ingestion confirmed owning `generate-sources-json.ts` + committed `sources.json` (2026-11-05).  
3. **Implementation of A–H is held** until Ian says go after this docs PR merges (or he explicitly starts work).  
