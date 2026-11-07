# Skills & Reports — implementation plans

**Owner:** BJ Skills & Reports  
**Mode:** plans only (skill drafts when Ian prioritizes)  
**Related:** PR F (report), PR G (new pipeline + schedule)

## 1) Generate report skill — PR F

**Goal:** Consultant asks a warehouse question → shareable GDoc/PDF/Spreadsheet from owned data (not Dune).

**Skill contents:** When-to-use; inputs (question, format gdoc|pdf|spreadsheet, wallets/assets, optional as-of); steps (clarify once → map to mart SQL → freshness check via Dagster if stale → read-only query → shape artifact with method/as-of footer → emit); outputs (file/link + one-line method); failure modes (warehouse down, missing mart, empty result, missing Google connector → local CSV/PDF); UX (glossary terms, one clarify max, sovereignty obvious).

**Marts today:** `analytics.latest_balances`, `analytics.erc20_transfers`, `analytics.dex_trades` (PIPELINES: balances/transfers/dex).

**Dependencies:** Running warehouse; optional Google connectors (local fallback). Outline already drafted in Skills 1:1 — ready to `UpdateSkill` on Ian go.

**Verification:** Dry-run one balances Q → spreadsheet locally; Quality Gate: glossary language, no invented stats, no “use Dune”.

**Out of scope:** Historical SQD/RPC, token prices/metadata, writing to raw.*, new pipelines.

## 2) New pipeline skill — PR G (part 1)

**Goal:** Teach consultant path from “I need a new source/pipeline” → scheduled Dagster job, without silent name drift.

**Skill contents:** (A) Prefer `bj new-source <source> <table> --like <template>` — scaffolds package, staging, and (after PR A) regenerates `sources.json` from exported name/table. (B) Explicit hand steps Quality Gate enforces as non-automatic: shape staging columns; add intermediate/mart (or “Adding a chain” for balances); add `PIPELINES` cron in `schedules.py`. (C) `pnpm install`; materialize; orchestration tests fail until asset is on a scheduled pipeline.

**Dependencies:** Soft-ship skill text vs current CLI; **hard-refresh after PR A** (`sources.json` + next-step → “Adding a chain”). Pair Transform for mart patterns.

**Verification:** Walkthrough against README + `new_source.py` next-steps; QG: skill must not claim mart/`PIPELINES` automatic.

**Out of scope:** Implementing `sources.json` (Orchestration/Ingestion), ERPC rename, multi-chain transfers code, inventing CLI flags.

## 3) Schedule jobs skill — PR G (part 2)

**Goal:** Change when a pipeline runs using the existing one-job-per-pipeline pattern only.

**Skill contents:** Edit `PIPELINES` dict in `orchestration/pipeline/schedules.py` (name → cron). Job selection = dbt mart path `models/marts/<name>` + upstream. Today: balances/transfers/dex all `0 6 * * *`. Restart/reload `dagster dev`. Point to Grafana pipeline dashboard. Never introduce Airflow / cron-outside-Dagster / second scheduler.

**Dependencies:** Pair @BJ Orchestration on wording; after New pipeline skill in the flow.

**Verification:** Skill cites `schedules.py` solely.

**Out of scope:** `bj doctor`, alerts, new schedule APIs, per-asset schedules.
