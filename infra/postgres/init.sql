-- Runs on every `docker compose up` (the warehouse-init service), so every statement is safe to rerun.
-- Expects the psql variable monitor_password.

-- pg_stat_statements keeps the text of statements such as ALTER ROLE, and the Pipeline dashboard
-- shows that text. This session does not record them, so the password below stays out.
SET pg_stat_statements.track_utility = off;

SELECT 'CREATE DATABASE erpc' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'erpc')\gexec

-- Needs shared_preload_libraries=pg_stat_statements, set on the warehouse service.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Grafana and postgres-exporter log in as monitor, which can read everything and change nothing.
SELECT 'CREATE ROLE monitor' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'monitor')\gexec
ALTER ROLE monitor WITH LOGIN PASSWORD :'monitor_password';
ALTER ROLE monitor SET default_transaction_read_only = on;
GRANT pg_monitor, pg_read_all_data TO monitor;

\ir ops.sql
