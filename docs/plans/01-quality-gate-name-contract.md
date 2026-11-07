# Quality Gate — name-contract check

**Owner:** BJ Quality Gate  
**Baseline:** plans only; no code until Ian prioritizes implementation  
**Related workstreams:** PR A (with Orchestration + Ingestion), PR D (ERPC rename review)

## Goal

Fail fast when dbt staging (and related naming) drifts from each ingestion package’s exported `name` / `table`, so consultants never get silent empty assets or orphan models.

Gate owns the **check** (freshness/drift tests + human review). Ingestion owns the generator script and committed `sources.json`. Orchestration owns loading that file into Dagster `SOURCES` and the `bj new-source` CLI hook.

## What check lives where

1. **Canonical input:** once Orchestration/Ingestion ship it, read `ingestion/sources.json` (built from each package’s exported `name`/`table`, not folder names).
2. **Automated test (repo):** CI/pytest (or small Node) test that:
   - loads every entry from `sources.json`
   - asserts matching dbt source YAML + staging model path/name for each `name`/`table`
   - fails with the missing or misspelled pair named in the message
3. **Freshness:** regenerate into temp and **fail on any diff** vs committed file (Ingestion constraint).
4. **Human gate:** every PR that adds/renames a source, staging model, or `bj new-source` behavior gets PASS/FAIL against this contract; docs/skills must not claim mart/`PIPELINES` are automatic.

## Pass / fail criteria

**PASS** when for every `sources.json` entry: dbt source schema + staging model exist and use the same `name`/`table`; Dagster consumes the file (no hand-edited third list); failure messages name the drift.

**FAIL** when staging or dbt sources YAML is missing/renamed without the package export; or when a PR adds a hand-maintained `SOURCES` list again; or when docs/skills say mart/`PIPELINES` are scaffolded by `bj new-source`.

Out of scope for this check: mart unions, `accepted_values`, `PIPELINES` cron (still manual; gate only ensures they aren’t falsely advertised).

## Dependencies

- Orchestration/Ingestion PR A: generate `sources.json` from package exports; `bj new-source` regenerates it; next-step points at Transform “Adding a chain”.
- Existing tests like `test_ingestion_feeds_its_staging_model` stay; this check hardens the full map.
- Ingestion keeps exporting stable `name`/`table` (folder ≠ export). Generator imports `src/source.ts` only (never `index.ts`).

## How I’ll review the Orchestration `sources.json` PR

- Reads **exported** `name`/`table`, not directory names
- Regenerates file on `bj new-source` (no append-to-`SOURCES`)
- Dagster builds `SOURCES` from the file
- CLI next-step → “Adding a chain”; no claim that mart/`PIPELINES` are automatic
- Tests cover regenerate + at least one deliberate drift failure message
- Freshness regenerate-and-diff test present

## How I’ll review the atomic `ERPC_URL` rename PR

**PASS only if one PR** updates every call site Orchestration/Ingestion listed. Compose `ERPC_PORT` / metrics / cache URLs stay. **FAIL** any partial rename, split across PRs, or `ERPC_URL` fallback.

## Sequencing

1. PR A ships `sources.json` + CLI message.
2. Gate/test PR lands against that file (same PR or immediate follow-up).
3. ERPC rename (PR D) is independent; gate whenever Ingestion opens it.
