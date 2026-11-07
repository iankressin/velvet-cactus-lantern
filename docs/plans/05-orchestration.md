# Orchestration — implementation plans

**Owner:** BJ Orchestration  
**Written against:** `main` @ `d24b6c4` (after #1 and #2)  
**Mode:** plans only  
**Build order:** Plan 1 before Plan 2 (`bj doctor` reads its source list from `sources.json`). Prefer local Mac worktrees while cloud credits are blocked.

---

## Plan 1: `sources.json` as the single list of sources — PR A

**Goal.** One committed file listing every source’s exported `name` and `table`, taken from the code and never from folder names. Dagster’s `SOURCES` is built from that file, and a test fails if the file falls out of date.

**How it’s generated.** New script `ingestion/scripts/generate-sources-json.ts`, pnpm script `generate-sources`. It imports each `ingestion/sources/*/src/source.ts` (side-effect-free — **never** `index.ts`) and picks exported objects with string `name` and `table` matching `SourceBase`. Writes `ingestion/sources.json` as a sorted list of `{name, table, package}`. Importing is safer than parsing (large Uniswap files). File is committed so Dagster/pytest never need Node to load it.

**Files**
- New: generator script and `ingestion/sources.json`
- Edit: `ingestion/package.json` (add script)
- Edit: `orchestration/pipeline/assets/ingestion.py` — `SOURCES` from JSON; package folder from `package` field
- Edit: `orchestration/pipeline/cli/new_source.py` — stop appending to `ingestion.py`; call generator after scaffolding; next-step → `transformation/README.md` section `## Adding a chain`; say plainly mart and `PIPELINES` stay hand steps
- Edit: README text that says add a source to `SOURCES` by hand

**Steps.** Write generator → commit first `sources.json` (today’s 9 pairs incl. uniswap_v2/v3/v4) → switch `ingestion.py` → point `new_source` at generator → update CLI next-step.

**Tests**
- Update `test_cli_new_source.py` to expect `sources.json` change, not a new line in `ingestion.py`
- Keep `test_ingestion_package_exists`, `test_ingestion_feeds_its_staging_model`, `test_every_asset_and_check_runs_in_a_scheduled_pipeline`
- Add `test_sources_json_is_fresh` (regenerate to temp, compare to committed — **fail on any diff**)
- Add `test_sources_json_package_dirs_exist`

**Risks.** Needs `pnpm install`. Assumes each `source.ts` exports exactly one Source and has no side effects when imported. Export names aren’t consistent — find by shape.

**Out of scope.** Auto mart / `PIPELINES`; renaming folders.

**Owners.** Ingestion: generator + `sources.json`. Orchestration: Dagster loading + `bj new-source` hook. Transform: “Adding a chain” section. Quality Gate: freshness / drift tests.

---

## Plan 2: `bj doctor` — PR B

**Goal.** One command that checks setup: env files, required keys (names only), ports, warehouse, eRPC and Dshackle health, tool versions. Never prints a secret value.

**Files.** New `orchestration/pipeline/cli/doctor.py`, `orchestration/tests/test_cli_doctor.py`; register in `cli/__init__.py`; README “Run it locally” one-liner.

**Checks**
1. Root `.env` exists — missing FAIL  
2. Each package in `sources.json` has `.env` — missing WARN; `--copy-env` copies from `.env.example`, never overwrites  
3. Validate required keys using the env schemas or an explicit required-key list, honoring optional fields and defaults (for example, an unset `PUSHGATEWAY_URL` is valid) — missing required values FAIL, report by name only  
4. Ports (defaults): warehouse 5432, eRPC 4000/4001, Dshackle 8545/8082, Grafana 3001, Prometheus 9090, Pushgateway 9091, Dagster 3000  
5. Warehouse reachable via `pipeline.warehouse.connect`  
6. eRPC `GET :4000/healthcheck` (verify; not set in `erpc.yaml` but on by default)  
7. Dshackle `GET :8082/health`  
8. Node 24 + pnpm 10.17.0 match `mise.toml`; `uv` installed (WARN if missing; not pinned)

**Output.** PASS/WARN/FAIL lines + summary. Exit 0 all passed, 1 at least one FAIL, 2 bad input.

**Tests.** `test_doctor_fails_without_root_env`, `test_doctor_warns_missing_source_env`, `test_doctor_copy_env_flag_copies_example`, `test_doctor_reports_missing_keys_without_values`, `test_doctor_erpc_health_uses_healthcheck_path` (HTTP/warehouse mocked).

**Risks.** eRPC 502 until upstreams start → WARN during startup. Health URLs assume compose default ports.

**Out of scope.** Starting compose; fixing bad keys; validating RPC key beyond reachability.

**Owners.** Orchestration. Reads Ingestion `.env.example` files. **Depends on Plan 1 / PR A.**

---

## Plan 3: Health checks and basic alerts — PR H

**Goal.** Compose health checks for `erpc` and `dshackle`; Prometheus alerts on failed runs, stale runs, RPC upstream errors.

**Files.** Edit `infra/docker-compose.yml`, `infra/prometheus/prometheus.yml` (add `rule_files`); new `infra/prometheus/alerts.yml`; short Monitoring note in README.

**Health checks**
- eRPC (`ghcr.io/erpc/erpc:0.5.0`): `GET /healthcheck` on 4000  
- Dshackle (`emeraldpay/dshackle:v0.18.0`): `GET /health` on 8082  
- Step 0: check whether images include `curl`/`wget` (unverified); else TCP check  
- ~10s interval, 6 retries (eRPC slow to start)

**Alert rules** (metrics from `ingestion/lib/src/run/metrics.ts` / `build_dashboards.py`)
- Failed run: `ingestion_last_run_success == 0`  
- Stale run: `time() - ingestion_last_success_timestamp_seconds > 90000` (25h, same as dashboard)  
- eRPC: rate of `erpc_upstream_request_errors_total` or `erpc_network_failed_request_total`  
- Dshackle: `dshackle_upstreams_availability` and `*_fail_total` (confirm labels on live scrape)  
- `run_log.py` writes Postgres `ops.*`, not Prometheus — alerts don’t use it

**Where alerts go.** Grafana built-in alerting rather than Alertmanager for v1 (Grafana already on :3001). Prometheus rules first, Grafana alerts second.

**Verification.** `docker compose up -d prometheus`; `/-/healthy` + Rules page. QG: metric names match `metrics.ts`.

**Risks.** Distroless images; eRPC 502 flap; no CI for rule syntax.

**Out of scope.** Alertmanager, PagerDuty/Slack, changing eRPC `healthCheck:` config, SQL-based alerts.

**Owners.** Orchestration. Ingestion owns metric names.
