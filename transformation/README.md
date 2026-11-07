# Transformation

dbt models that read each source's raw table and build the marts consultants query.

Ethereum hex addresses are lowercased in staging. Solana and Bitcoin addresses are kept as-is because they are case-sensitive (base58).

## Adding a chain

First follow [Add a source](../docs/architecture.md#add-a-source) to load the chain's raw data. Its steps add the dbt sources YAML and the staging models, and regenerate `ingestion/sources.json`, which Dagster builds its `SOURCES` from. Then:

1. Add `int_<chain>_balances.sql` and its contract YAML, copied from an existing chain in `models/intermediate/balances/`. Set `decimals` to the native asset's decimals on native rows and to null on token rows. The contract names any missing or mistyped column at build time.
2. Add a `union all` branch for that model in `models/marts/balances/latest_balances.sql`.
3. Add the chain to the `accepted_values` of `blockchain` in `models/marts/balances/_balances__models.yml`.
