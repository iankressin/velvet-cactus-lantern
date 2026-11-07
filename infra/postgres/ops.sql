-- Plain SQL with no psql commands, so the ingestion tests can load it into PGlite.
-- init.sql runs it on every `docker compose up`, so every statement is safe to rerun.

-- The run log. Ingestion writes ingestion_runs, the Dagster dbt asset writes the dbt tables,
-- and the Pipeline dashboard reads all three.
CREATE SCHEMA IF NOT EXISTS ops;

CREATE TABLE IF NOT EXISTS ops.ingestion_runs (
  run_id uuid PRIMARY KEY,
  dagster_run_id text,
  source text NOT NULL,
  table_name text NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  succeeded boolean NOT NULL,
  records_written integer NOT NULL,
  failed_calls integer NOT NULL,
  retried_calls integer NOT NULL,
  load_seconds double precision NOT NULL,
  -- Null when the run failed before it counted its dead letters.
  dead_letters_pending integer,
  dead_letters_parked integer,
  error text
);
CREATE INDEX IF NOT EXISTS ingestion_runs_started_at ON ops.ingestion_runs (started_at);
CREATE INDEX IF NOT EXISTS ingestion_runs_dagster_run_id ON ops.ingestion_runs (dagster_run_id);

CREATE TABLE IF NOT EXISTS ops.dbt_invocations (
  invocation_id uuid PRIMARY KEY,
  dagster_run_id text,
  command text NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  succeeded boolean NOT NULL,
  dbt_version text,
  error text
);
CREATE INDEX IF NOT EXISTS dbt_invocations_started_at ON ops.dbt_invocations (started_at);
CREATE INDEX IF NOT EXISTS dbt_invocations_dagster_run_id ON ops.dbt_invocations (dagster_run_id);

-- One row per model, test, seed or snapshot that an invocation selected.
CREATE TABLE IF NOT EXISTS ops.dbt_node_runs (
  invocation_id uuid NOT NULL REFERENCES ops.dbt_invocations ON DELETE CASCADE,
  unique_id text NOT NULL,
  resource_type text NOT NULL,
  name text NOT NULL,
  status text NOT NULL,
  -- Null for a node that was skipped.
  started_at timestamptz,
  finished_at timestamptz,
  execution_seconds double precision NOT NULL,
  -- Rows a table model or seed wrote. Null for views, tests and ephemeral models.
  rows_affected bigint,
  -- Rows that failed a test.
  failures integer,
  message text,
  PRIMARY KEY (invocation_id, unique_id)
);

-- One row per pipeline run: a Dagster run, or an ingestion run or dbt build started by hand.
-- run_key is the Dagster run id, or the run's own id for one started by hand.
CREATE OR REPLACE VIEW ops.pipeline_runs AS
WITH ingestion AS (
  SELECT
    coalesce(dagster_run_id, run_id::text) AS run_key,
    max(dagster_run_id) AS dagster_run_id,
    min(started_at) AS started_at,
    max(finished_at) AS finished_at,
    count(*) AS sources,
    count(*) FILTER (WHERE NOT succeeded) AS sources_failed,
    sum(records_written) AS records_written,
    sum(failed_calls) AS failed_calls
  FROM ops.ingestion_runs
  GROUP BY 1
),
transformation AS (
  SELECT
    coalesce(i.dagster_run_id, i.invocation_id::text) AS run_key,
    max(i.dagster_run_id) AS dagster_run_id,
    min(i.started_at) AS started_at,
    max(i.finished_at) AS finished_at,
    bool_and(i.succeeded) AS succeeded,
    count(*) FILTER (WHERE n.resource_type <> 'test' AND n.status = 'success') AS models_built,
    count(*) FILTER (WHERE n.resource_type <> 'test' AND n.status <> 'success') AS models_not_built,
    count(*) FILTER (WHERE n.resource_type = 'test' AND n.status = 'pass') AS tests_passed,
    count(*) FILTER (WHERE n.resource_type = 'test' AND n.status = 'warn') AS tests_warned,
    count(*) FILTER (WHERE n.resource_type = 'test' AND n.status IN ('fail', 'error')) AS tests_failed
  FROM ops.dbt_invocations i
  LEFT JOIN ops.dbt_node_runs n USING (invocation_id)
  GROUP BY 1
)
SELECT
  run_key,
  coalesce(i.dagster_run_id, t.dagster_run_id) AS dagster_run_id,
  least(i.started_at, t.started_at) AS started_at,
  greatest(i.finished_at, t.finished_at) AS finished_at,
  CASE WHEN coalesce(i.sources_failed, 0) > 0 OR NOT coalesce(t.succeeded, true)
    THEN 'failed' ELSE 'succeeded' END AS status,
  coalesce(i.sources, 0) AS sources,
  coalesce(i.sources_failed, 0) AS sources_failed,
  coalesce(i.records_written, 0) AS records_written,
  coalesce(i.failed_calls, 0) AS failed_calls,
  t.run_key IS NOT NULL AS transformed,
  coalesce(t.models_built, 0) AS models_built,
  coalesce(t.models_not_built, 0) AS models_not_built,
  coalesce(t.tests_passed, 0) AS tests_passed,
  coalesce(t.tests_warned, 0) AS tests_warned,
  coalesce(t.tests_failed, 0) AS tests_failed
FROM ingestion i
FULL JOIN transformation t USING (run_key);
