# Transformation

dbt models that read each source's raw table and build the marts consultants query.

Ethereum hex addresses are lowercased in staging. Solana and Bitcoin addresses are kept as-is because they are case-sensitive (base58).

## Adding a chain

`bj new-source` already scaffolds the dbt sources YAML and a staging model that selects `id`, `data` and `_loaded_at` from that source, then regenerates `ingestion/sources.json`, which Dagster builds its `SOURCES` from. See `orchestration/pipeline/cli/new_source.py`. It does not add the chain to a mart, and it schedules nothing: `PIPELINES` in `orchestration/pipeline/schedules.py` stays a hand step.

The remaining steps, by hand:

1. Add `int_<chain>_balances.sql` and its contract YAML, copied from an existing chain in `models/intermediate/balances/`. The contract names any missing or mistyped column at build time.
2. Add a `union all` branch for that model in `models/marts/balances/latest_balances.sql`.
3. Add the chain to the `accepted_values` of `chain` in `models/marts/balances/_balances__models.yml`.
