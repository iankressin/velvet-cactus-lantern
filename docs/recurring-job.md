# Run balance capture as a recurring job

This page explains how the `balances` pipeline would run every day for an organization. It says what the repo builds today and marks the rest as proposed or planned. Names match the code in this commit. [TAKE-HOME.md](../TAKE-HOME.md) says how to run the pipeline once.

## Four layers, each read from the one before

dbt builds every layer after raw. You can drop the `analytics` schema and rebuild it from `raw` with one `dbt build`.

| Layer | Schema | Built as | Balance models today |
|---|---|---|---|
| Raw | `raw` | Tables the TypeScript sources write | `ethereum_eth_balances`, `ethereum_erc20_balances`, `solana_sol_balances`, `solana_spl_balances`, `bitcoin_btc_balances`, and `_dead_letters` |
| Staging | `analytics` | dbt views | `stg_ethereum__eth_balances`, `stg_ethereum__erc20_balances`, `stg_solana__sol_balances`, `stg_solana__spl_balances`, `stg_bitcoin__btc_balances` |
| Intermediate | `analytics` | dbt views | `int_ethereum_balances`, `int_solana_balances`, `int_bitcoin_balances` |
| Marts | `analytics` | dbt tables | `latest_balances` |

Each layer has one job:

- Raw keeps each reading as the source parsed it, as JSON in `data`. A source writes its rows and its failed calls in one transaction.
- Staging casts the JSON to typed columns, `bigint` for blocks and `numeric` for balances. It lowercases Ethereum addresses. It keeps Solana and Bitcoin addresses as written, since base58 is case-sensitive.
- Intermediate puts every chain in one shape: `chain`, `wallet`, `asset_type`, `asset`, `block_number` and `balance`. It drops ERC-20 reads that reverted. On Solana `block_number` holds the slot, and on Bitcoin the height.
- The mart stacks the three intermediate models and keeps the latest reading of each chain, wallet and asset.

Token metadata takes the same path in its own pipeline, `tokens`. `raw.ethereum_erc20_metadata` and `raw.solana_spl_metadata` feed `stg_ethereum__erc20_metadata` and `stg_solana__spl_metadata`, then `int_ethereum_erc20_metadata` and `int_solana_spl_metadata`, then the `tokens` mart.

The run log has a schema of its own, `ops`, which `infra/postgres/ops.sql` creates. `ops.ingestion_runs` holds one row per source run. `ops.dbt_invocations` and `ops.dbt_node_runs` hold each dbt build and each model and test in it. The view `ops.pipeline_runs` joins them into one row per Dagster run.

## Keep each reading and how it was fetched

When someone asks where a balance came from, the answer needs the run, the time, the provider, the block and the input file behind it. The raw tables keep part of that today. This table lists each item, where it lives now, and what to add.

| Item | Kept today | Where | Proposed change |
|---|---|---|---|
| Run id | Per source run, not per row | `ops.ingestion_runs.run_id`, and `dagster_run_id`, which ties a source run to the dbt build of the same Dagster run | Add `_run_id` to each raw row |
| Fetch time | Write time only | `_loaded_at` on each raw row, which a rewrite of the row resets. `started_at` and `finished_at` in `ops.ingestion_runs`. | Add `_fetched_at`, the time the reply arrived |
| Provider and endpoint | No | Nowhere | Planned `_upstream` column, below |
| Block, slot or height | Yes | `block_number` or `slot` in `data`, and the first part of the row's `id` | None |
| Raw reply | Parsed fields only | `data` holds the wallet, token, block and balance, not the JSON-RPC reply | Add `_reply` with the reply body. For SPL it lists each token account the source sums. |
| Error text | Last error per failed call | `raw._dead_letters`: `error`, `attempts`, `first_failed_at`, `last_failed_at` and `parked`. `ops.ingestion_runs.error` for a run that failed. | Keep every error, not only the last |
| Input file hash | No | Nowhere | Add `input_sha256` to `ops.ingestion_runs`, and keep the file's rows in `raw.wallet_assets` |

A planned change adds an `_upstream` column to every raw table. It is not built yet. For the EVM and Solana call sources, the column will hold the eRPC upstream that answered, such as `eth-blastapi` or `sol-publicnode`, which eRPC names in its `X-Erpc-Upstreams` reply header. It will hold null when eRPC answered from its cache, and when the replies inside one read name different upstreams. Bitcoin rows will hold null too, because Dshackle sends no header that names the upstream. A source that calls an RPC directly, as the two Ethereum balance sources do by default, will record the URL's host, such as `eth.drpc.org`.

The input rows matter because `latest_balances` keeps every pair that any run loaded. A pair you remove from the CSV keeps its last balance there. With the file's rows stored by hash, a mart can keep only the pairs the latest file asks for.

Keep all raw rows. One daily run of the example file writes 971 readings when every call succeeds, about 355,000 rows a year.

## Tables by grain

Each row of this table names one table, what one of its rows means, and who reads it.

| Layer | Table | One row is | Why |
|---|---|---|---|
| Raw | `raw.<chain>_<asset>_balances` | One reading of one wallet and asset at one block, slot or height. A rerun at the same block replaces the row. | The audit trail. dbt rebuilds every later model from it. |
| Raw | `raw._dead_letters` | One failed call of one source | The retry queue. An operator reads the error of a parked call. |
| Raw (proposed) | `raw.wallet_assets` | One line of one input file, by file hash | Records which pairs each run was asked for. |
| Ops | `ops.ingestion_runs` | One run of one source | Run history. The Pipeline dashboard reads it. |
| Cleaned | `stg_*` | One raw row, typed | Later models read columns, not JSON, with one address case per chain. |
| Cleaned | `int_<chain>_balances` | One reading of one wallet and asset at one block | One shape across chains. The mart stacks these. |
| Mart | `tokens` | One token on one chain, latest reading | Decimals, name and symbol. Anyone who turns base units into whole tokens joins on `chain` and `token`, never on `symbol`. |
| Mart | `latest_balances` | One chain, wallet and asset, latest reading, in base units | Answers "what does this wallet hold now?" |
| Rollup (proposed) | `daily_wallet_balances` | One wallet and asset on one UTC day | History and charts for analysts. |
| Rollup (proposed) | `daily_token_totals` | One chain and token on one UTC day | Treasury questions, such as "how much USDC do our wallets hold on Solana?" |
| Rollup (proposed) | `daily_portfolio_value` | One wallet on one UTC day, in USD | Finance reporting. |

The rollups follow three rules:

- `daily_wallet_balances` takes the last reading on or before the end of each day. A day with no reading copies the day before and sets `carried_forward`, so a failed run shows as a flat line, not a drop to zero.
- `daily_token_totals` sums `daily_wallet_balances` per chain and token. It keeps chains apart, because USDC on Ethereum and USDC on Solana are two tokens.
- `daily_portfolio_value` multiplies whole tokens by a daily price from `analytics.token_prices`, which holds Binance and Coinbase candles. `tokens` warns against joins on `symbol`, so a seed would map each chain and token to the exchange symbol that prices it. The table counts the assets it could not price, so a missing price does not pass for a lower total.

## Table definitions show each grain

Each primary key below is the table's grain. dbt builds the staging and intermediate models as views and the marts as tables. These statements show their columns as Postgres DDL. A `proposed` or `planned` comment marks a column or table the repo does not have.

Raw, as the warehouse code creates it, plus the proposed columns:

```sql
-- One reading of one wallet and mint at one slot.
create table raw.solana_spl_balances (
	id text primary key,                     -- '<slot>:<mint>:<wallet>'
	data jsonb not null,                     -- slot, mint, wallet, and balance as a string
	_loaded_at timestamptz not null default now(),
	_run_id uuid,                            -- proposed: ops.ingestion_runs.run_id
	_fetched_at timestamptz,                 -- proposed: when the reply arrived
	_upstream text,                          -- planned: the eRPC upstream that answered
	_reply jsonb                             -- proposed: the JSON-RPC reply body
);

-- One failed call of one source. A record with the same id clears it.
create table raw._dead_letters (
	source_table text not null,              -- such as 'solana_spl_balances'
	id text not null,                        -- the call's id, such as '<mint>:<wallet>'
	call jsonb not null,
	error text not null,
	attempts integer not null default 1,
	parked boolean not null default false,   -- true after 5 failed runs
	first_failed_at timestamptz not null default now(),
	last_failed_at timestamptz not null default now(),
	primary key (source_table, id)
);

-- Proposed: one line of one input file.
create table raw.wallet_assets (
	input_sha256 text not null,
	line integer not null,
	blockchain text not null,
	wallet_address text not null,
	token_address text,                      -- null for the native asset
	_loaded_at timestamptz not null default now(),
	primary key (input_sha256, line)
);
```

Cleaned, the intermediate model for Ethereum:

```sql
-- One reading of one wallet and asset at one block.
create table analytics.int_ethereum_balances (
	id text not null unique,                 -- the raw row's id
	chain text not null,                     -- 'ethereum'
	wallet text not null,                    -- lowercased
	asset_type text not null,                -- 'native' or 'erc20'
	asset text not null,                     -- 'eth', or the token address, lowercased
	block_number bigint not null,
	balance numeric not null,                -- base units
	_loaded_at timestamptz not null,
	primary key (chain, wallet, asset, block_number)
);
```

Marts:

```sql
-- One chain, wallet and asset, at its latest reading.
create table analytics.latest_balances (
	chain text not null,                     -- 'ethereum', 'solana' or 'bitcoin'
	wallet text not null,
	asset_type text not null,                -- 'native', 'erc20' or 'spl'
	asset text not null,                     -- 'eth', 'sol', 'btc', or the token or mint address
	block_number bigint not null,            -- the block, slot or height of the reading
	balance numeric not null,                -- wei, lamports, satoshis, or token base units
	primary key (chain, wallet, asset)
);

-- One token on one chain, at its latest reading.
create table analytics.tokens (
	chain text not null,
	token text not null,                     -- lowercased on EVM chains, as written on Solana
	name text,
	symbol text,
	decimals integer,                        -- null when the contract or mint does not say
	block_number bigint not null,            -- the slot on Solana
	primary key (chain, token)
);
```

Rollups, all proposed:

```sql
-- One wallet and asset on one UTC day.
create table analytics.daily_wallet_balances (
	day date not null,
	chain text not null,
	wallet text not null,
	asset text not null,
	asset_type text not null,
	block_number bigint not null,            -- the reading the day ends on
	balance numeric not null,                -- base units
	balance_tokens numeric,                  -- null when decimals are unknown
	carried_forward boolean not null,        -- true when no run read the pair that day
	primary key (day, chain, wallet, asset)
);

-- One chain and token on one UTC day, summed over the tracked wallets.
create table analytics.daily_token_totals (
	day date not null,
	chain text not null,
	asset text not null,
	holders integer not null,                -- wallets with a balance above zero
	balance numeric not null,                -- base units
	balance_tokens numeric,
	primary key (day, chain, asset)
);

-- One wallet on one UTC day, in USD.
create table analytics.daily_portfolio_value (
	day date not null,
	chain text not null,
	wallet text not null,
	value_usd numeric not null,              -- the sum over priced assets only
	priced_assets integer not null,
	unpriced_assets integer not null,        -- assets with no price or no decimals that day
	primary key (day, chain, wallet)
);
```

## Schedule, retries and alerts

### Schedule

`PIPELINES` in `orchestration/pipeline/schedules.py` gives each pipeline a Dagster job and a cron schedule. The `balances` job selects the models in `transformation/models/marts/balances/` and everything upstream of them: the five balance sources, then their staging and intermediate models. It runs at `0 6 * * *`, which is 06:00 UTC each day. The `tokens` job refreshes decimals on the same cron.

Dagster starts each schedule in the stopped state. Turn on `balances_schedule` and `tokens_schedule` in the Dagster UI before you rely on them. `dagster dev`, which `bj dev` starts, runs the daemon that fires schedules. For a job that must keep running, run `dagster-webserver` and `dagster-daemon` as services with a Postgres-backed `DAGSTER_HOME`, so the run history survives a restart (proposed).

`bj run balances` runs the same job once, in the current process.

### Retries

A call gets four chances to succeed, from the client out to the job:

1. The client. The EVM client (viem) retries a request up to 5 times. The Solana client retries up to 5 times with backoff, but not an HTTP error, which eRPC has already retried.
2. The proxy. eRPC tries a request up to 5 times across its upstreams, with backoff up to 5 seconds. After 2 seconds it sends a second copy to another upstream. Each upstream gets 2 attempts and 15 seconds. Dshackle sends a Bitcoin call to the next upstream when one answers HTTP 429.
3. The next run. A call that still fails becomes a dead letter in `raw._dead_letters`. The source writes its other rows, and the run succeeds. The next run retries each pending dead letter. After 5 failed runs the dead letter is parked and waits for a person.
4. The job. The Dagster jobs set no retry policy. A source fails its step only when the whole run fails, such as on a bad input row or an unreachable warehouse. Dagster then skips the models downstream, and `latest_balances` keeps its last build. A Dagster `RetryPolicy` on the ingestion assets, with 2 retries 5 minutes apart, would cover a short outage (proposed).

### Alerts and dashboards

Each source run pushes its result to the Pushgateway. Prometheus scrapes the Pushgateway, eRPC and Dshackle, and evaluates the rules in `infra/prometheus/alerts.yml`:

| Rule | Fires when |
|---|---|
| `IngestionRunFailed` | A source run failed |
| `IngestionRunStale` | A source has had no successful run for over 25 hours, which on a daily schedule means a missed run |
| `IngestionDeadLettersParked` | A call failed 5 runs in a row |
| `ScrapeTargetDown` | Prometheus cannot scrape a target |
| `ErpcUpstreamErrorRate`, `ErpcNetworkFailedRequests` | eRPC upstreams or networks return errors |
| `DshackleNoAvailableUpstream`, `DshackleFailedRequests`, `DshackleUpstreamErrors` | Dshackle has no upstream, or its requests fail |

Grafana lists the same rules under **Alerting**. The repo sets up no contact point, so an alert shows in Prometheus and Grafana but notifies no one. Add one, such as email or a chat channel, before the job runs unattended (proposed).

dbt tests also check the marts. `latest_balances_one_row_per_wallet_asset` fails when a pair appears twice, and the mart's columns carry `not_null` and `accepted_values` tests. Each raw table's `id` has a `unique` test. In Dagster, each source has a `no_dead_letters` check that warns while calls wait in `raw._dead_letters`.

Grafana serves four dashboards from `infra/grafana/dashboards/`, on `GRAFANA_PORT` (3001 by default):

- Pipeline (`pipeline.json`) shows every run, with its ingestion and dbt steps side by side, and the warehouse and eRPC during the run.
- Ingestion (`ingestion.json`) shows each source's last run, records written, failed calls, run time and dead letters.
- eRPC (`erpc.json`) shows requests, errors and rate limits per upstream.
- Dshackle (`dshackle.json`) shows the Bitcoin upstreams and their errors.
