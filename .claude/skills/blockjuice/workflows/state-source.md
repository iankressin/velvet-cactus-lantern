# Add a state source

A state source reads values that a view function or RPC method returns at one block. The balances sources are the pattern to follow, for example `ingestion/sources/evm-erc20-balances/`.

1. Scaffold from the closest existing source:

   ```sh
   uv run --project orchestration bj new-source <chain> <table> --like <package>
   ```

   It copies the package, sets its `name` and `table`, adds the dbt source with a staging stub, then runs `pnpm install` and `pnpm generate-sources` in `ingestion/`, which rewrites `ingestion/sources.json`, the list Dagster builds its `SOURCES` from. [new-pipeline.md](new-pipeline.md) says what it does in full, and what stays by hand: the mart and `PIPELINES`.

2. Edit the copied `src/`. It extracts and loads only, per [../references/layers.md](../references/layers.md): each record is a call's result as the chain returned it, and units, joins and rules go in dbt.
   - Give each call its block number in the `call` zod schema, so a call retried in a later run reads the same block. On EVM, `connect(env)` from `@ingestion/lib/evm` returns the client and `BLOCK_NUMBER` turned into one number for the run.
   - Make calls through `settleCalls` from `@ingestion/lib`. The EVM client merges reads at one block into one Multicall3 call. On Solana, use `createSolanaClient` from `@ingestion/lib/solana`.
   - Code that more than one source of a chain needs goes in `ingestion/lib/src/<chain>/`, exported from its `index.ts`.
   - A revert at a pinned block is a fact to record as null, not a failure to retry. Copy `balanceAt` in `evm-erc20-balances/src/balances.ts`.
   - Reads at past blocks need an archive RPC. Solana serves current state only, so a Solana call has no block, and the record's id takes the slot from the reply.
3. Put the addresses to read in `addresses.json`, in `chains/<chain>/` for an `evm-*` package. Copy `.env.example` to `.env`.
4. Update the copied tests in `src/*.test.ts`. Run `pnpm test` in the package and `pnpm typecheck` in `ingestion/`.
5. Shape the staging model: cast each field out of `data` into its own column, as `stg_ethereum__erc20_balances.sql` does. Add column tests to the folder's `_<chain>__models.yml`.
6. Run it once with `pnpm ingest` in the package, as `CHAIN=<chain> pnpm ingest` for an `evm-*` package. Check that `raw.<chain>_<table>` has rows and that `raw._dead_letters` has none for `<chain>_<table>`.

A source joins a pipeline through a mart that reads it: follow [new-pipeline.md](new-pipeline.md). Until then the orchestration tests fail, because every asset must belong to a scheduled pipeline.
