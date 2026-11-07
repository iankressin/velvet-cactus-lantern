A take-home prototype that reads current balances over RPC for a list of wallets and tokens on Ethereum, Solana and Bitcoin. It reads `input/wallet-assets.csv` and writes `output/<run_id>_balances.csv`, with one row per requested wallet and asset and the balance in whole tokens.

It covers ETH and ERC-20 tokens, SOL and SPL tokens, and BTC. Eight TypeScript sources in `ingestion/` make the RPC calls and load raw rows into Postgres: five read balances, two read token decimals and one loads the input file. dbt in `transformation/` turns those rows into `analytics.requested_balances`. Dagster in `orchestration/` runs both as one `balances` job and writes the CSV. The `bj` CLI sets it up and runs it.

| The assignment asks for | Where |
|---|---|
| How to configure and run it, and its dependencies | [Setup](#setup), [Running the balances job](#running-the-balances-job) |
| The input format | [Input CSV](#input-csv) |
| Assumptions and limitations | [Assumptions and limitations](#assumptions-and-limitations) |
| How to make it a recurring job: layers, retained data, tables, CREATE TABLE | [From prototype to recurring job](#from-prototype-to-recurring-job) |

## Setup

You need Docker with the compose plugin, [uv](https://docs.astral.sh/uv/), Node 24 and pnpm 10.17.0. `mise.toml` pins Node and pnpm, so `mise install` sets up both. `uv run` installs the Python packages, Dagster and dbt among them, on first use. They need Python 3.10 to 3.13.

Run these from the repo root:

```sh
uv run --project orchestration bj install   # .env files, Node packages, dbt manifest
uv run --project orchestration bj dev       # Docker stack, checks, then Dagster
uv run --project orchestration bj doctor    # check the setup at any time
docker compose down                         # stop the Docker stack
```

`bj install` copies `.env.example` to `.env` at the root and in each package under `ingestion/sources/` that has none. The root `.env` holds what dbt, Dagster and Docker share, such as the warehouse login and the ports. Each source has its own `.env`. `bj install` never overwrites an `.env` and starts nothing. It also runs `pnpm install --frozen-lockfile` in `ingestion/` and `dbt parse`.

`bj dev` runs `bj install` again, starts the Docker stack and runs the `bj doctor` checks. If none fails, it runs `dagster dev`. It stops at once if port 3000 is taken. Ctrl-C stops Dagster and leaves the stack up.

Dagster's UI is at http://localhost:3000. Grafana is at http://localhost:3001; sign in as `admin`/`admin` to edit. The stack also takes ports 5432 (Postgres), 4000 and 4001 (eRPC), 8545 and 8082 (Dshackle), 9090 (Prometheus) and 9091 (Pushgateway). If 5432 is taken, set `WAREHOUSE_PORT` in the root `.env`.

### RPC endpoints

The defaults need no API key. The sources call two proxies that run in Docker. eRPC, on port 4000, sends Ethereum and Solana calls to the free public RPCs in `infra/erpc/erpc.yaml`. Dshackle, on port 8545, sends Bitcoin calls to those in `infra/dshackle/dshackle.yaml`. The free Solana and Bitcoin RPCs have tight rate limits; see [Assumptions and limitations](#assumptions-and-limitations).

To use your own endpoint, such as a QuickNode or Alchemy URL, set `EVM_RPC_URL`, `SOLANA_RPC_URL` or `DSHACKLE_URL` (Bitcoin) in the root `.env`. Under `bj` and Dagster, a key there wins over each source's own `.env`. Git ignores every `.env`. A Bitcoin endpoint must serve `scantxoutset`, which the Bitcoin source calls.

To keep eRPC's cache and retries, add the URL as an upstream in `infra/erpc/erpc.yaml` instead, and keep the key out of git. Then restart eRPC:

```sh
docker compose restart erpc
```

## Running the balances job

### Input CSV

The job reads `input/wallet-assets.csv`, one row per wallet and asset:

```csv
blockchain,wallet_address,token_address
ethereum,0x47ac0Fb4F2D84898e4D9E7b4DaB3C24507a6D503,
ethereum,0x47ac0Fb4F2D84898e4D9E7b4DaB3C24507a6D503,0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
solana,GoGoGo6N99mpyB7rfzhw2R4fXmaFctURXHaHMoGCyoLD,
solana,GoGoGo6N99mpyB7rfzhw2R4fXmaFctURXHaHMoGCyoLD,mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So
bitcoin,3DTxtzoqm1vb9RHVXQWStRZZc69zUT2WRB,
```

- `blockchain` is `ethereum`, `solana` or `bitcoin`, in lowercase. An empty `token_address` means the native asset: ETH, SOL or BTC. Otherwise it holds an ERC-20 contract or an SPL mint. Bitcoin rows must leave it empty.
- Ethereum addresses may be lowercase or EIP-55 checksummed, and match in any case. Solana addresses are case-sensitive. The output keeps each address as written.
- The job skips a bad row with a warning that names its line, and reads the rest. It reads a repeated row once, and the output shows it once, at its first line. A missing column, a byte order mark or a file with no rows fails the run.

The default file has 64 rows for 20 wallets. For the full run, use `input/wallet-assets-250.csv`, the same file as `examples/wallet-assets.csv`. It has 971 rows for 250 wallets (100 Ethereum, 90 Solana, 60 Bitcoin), with 1 to 10 assets each.

To read another file, pass its path to `bj run --wallet-assets`. You can also set `WALLET_ASSETS_CSV` in the Launchpad, or in `.env`, which `bj` reads when it starts. That variable takes a path from each source's package folder, such as `../../../input/wallet-assets-250.csv`.

### From the terminal

```sh
uv run --project orchestration bj run balances
uv run --project orchestration bj run balances --wallet-assets input/wallet-assets-250.csv
```

`bj run` parses the dbt project, then runs the `balances` job: the ingestion sources, the dbt models, then the CSV. It ends with `balances: run <run_id> succeeded`. If the run fails, it names each failed step and exits 1. Unless `DAGSTER_HOME` is set, the run does not show in the Dagster UI.

### From the Dagster UI

1. Open http://localhost:3000, go to Jobs and pick `balances`.
2. Click Materialize all to run with the values in the `.env` files.
3. To change a value for one run, open the arrow next to Materialize all and pick Open launchpad. Click Scaffold all default config to list each source's env variables with the values it reads now. Shared ones, such as `WALLET_ASSETS_CSV`, sit under `resources.ingestion_env.config`. Edit any of them, then click Materialize.
4. Open the run under Runs to see its id. In the run's log, the `balances_csv` step shows the file `path`, its `rows` and a count per status.

The `balances_schedule` schedule runs the job daily at 06:00 UTC (`0 6 * * *` in `orchestration/pipeline/schedules.py`). It starts off; turn it on under Automation. It fires only while `bj dev` runs, and without `DAGSTER_HOME` Dagster forgets the switch when `bj dev` stops.

### Output

Each run writes `output/<run_id>_balances.csv`, or the path in `BALANCES_CSV_PATH` with the run id before the file name. It has one row per requested wallet and asset, in input order.

| Column | Meaning |
|---|---|
| `blockchain`, `wallet_address`, `token_address` | As written in the input; an empty `token_address` shows as `native` |
| `balance_tokens` | Balance in whole tokens, exact; empty unless `status` is `ok` |
| `asset_type` | `native`, `erc20` or `spl`; empty for `invalid_input` |
| `decimals` | 18 for ETH, 9 for SOL, 8 for BTC, else the token's own |
| `balance_raw` | Balance in base units: wei, lamports, satoshis or token units |
| `status` | `ok`, `unknown_decimals`, `no_reading` or `invalid_input`, below |
| `block_number`, `read_at` | The block, or Solana slot, of the reading, and when it loaded, in UTC |
| `input_line` | The input line this row answers; the header is line 1 |

`ok` means the row has a balance. `unknown_decimals` means it has `balance_raw`, but the token's decimals are unknown. `no_reading` means no run has read the pair yet. `invalid_input` means the line names no valid pair; the run log says why.

To query the same rows in the warehouse:

```sh
docker compose exec warehouse psql -U elt -d warehouse -c "select blockchain, wallet_address, token_address, balance_tokens, status from analytics.requested_balances order by input_line limit 10"
```

## Assumptions and limitations

### Assumptions

- "Current" means a different point on each chain. Each Ethereum source turns `BLOCK_NUMBER` (`finalized` by default) into one block when its run starts. Solana reads the latest finalized slot, and Bitcoin reads the chain tip. So rows on different chains do not share one moment, and neither do SPL rows, since each comes from its own call. Each row's `block_number` says what it read.
- All three chains are mainnet, read through free public RPCs that need no API key. eRPC (Ethereum, Solana) and Dshackle (Bitcoin) spread the calls over several upstreams and switch to another when one fails.
- The CSV accepts `ethereum`, `solana` and `bitcoin`. Ethereum is the only EVM chain it takes.
- Token decimals come from the chain: the ERC-20 `decimals()` call and the SPL mint. When a token reports none, its row keeps `balance_raw`, leaves `balance_tokens` empty and has status `unknown_decimals`. The tool never guesses 18. Native decimals are fixed: 18 for ETH, 9 for SOL, 8 for BTC.
- An SPL balance is the sum of every token account the wallet holds for the mint, under both the Token and Token-2022 programs. A SOL balance is the lamports in the wallet's own account only.
- A Bitcoin wallet is one mainnet address: P2PKH, P2SH, P2WPKH, P2WSH or P2TR. The tool does not expand an xpub or group several addresses into one wallet.

### Limitations

- It is not one script. It needs Docker, Node 24, pnpm and uv, and runs Postgres, eRPC and Dshackle in containers. In return, every reading stays in `raw.*`, so each balance traces back to the call that made it. Failed calls retry on the next run, and Dagster can run the job on a schedule.
- Free RPCs refuse calls or time out under load. A failed call does not fail the run. It waits in `raw._dead_letters`, retries on the next run, and stops retrying after 5 failed runs until a person looks at it. SPL is the tightest: it makes one `getTokenAccountsByOwner` call per wallet and mint, and the two free upstreams that serve it allow 10 calls a minute and 1 a second.
- When a run cannot read a pair, the CSV keeps the last good reading and still says `ok`. Only an old `read_at` and `block_number` show that it is stale. `no_reading` covers both a pair no run has read and an ERC-20 whose `balanceOf` reverts or returns nothing, such as an address with no contract.
- Bitcoin depends on one upstream. Only OnFinality's free endpoint serves `scantxoutset`, which scans the whole UTXO set once for all wallets and took 43 to 96 seconds when measured. If that call fails, every BTC row shows its last good reading.
- A source run that fails outright, such as on a bad input file or an RPC that cannot name the block, stops the job before dbt, so it writes no CSV.
- Solana and Bitcoin RPCs serve only current state, so the tool cannot read a past balance there. Ethereum can read a past block through `BLOCK_NUMBER`, but `latest_balances` keeps the highest block read, so a past block does not replace a newer reading.
- No prices or USD values.

## From prototype to recurring job

The `balances` job already has a daily schedule at 06:00 UTC (`orchestration/pipeline/schedules.py`), off until you turn it on. Each run adds new readings to `raw`, rebuilds the marts and writes a new CSV. Prometheus alerts when a source run fails, when a source has not succeeded for 25 hours, and when a source has parked dead letters (`infra/prometheus/alerts.yml`).

For an organization I would keep the daily cadence but run just after 00:00 UTC, so each reading lands close to the end of the day it reports. The EVM sources could read at the last block before midnight. Solana and Bitcoin read only current state, so their stored block time shows how close each reading got. Finance and dashboards would read warehouse tables, not CSV files.

### Layers

| Layer | Schema | Holds | Read by | Status |
|---|---|---|---|---|
| Raw | `raw` | One JSON row per reading in `raw.<source>_<table>`, each input line in `raw.input_wallet_assets`, failed calls in `raw._dead_letters` | dbt, people debugging | Exists |
| Run log | `ops` | `ingestion_runs`, `dbt_invocations`, `dbt_node_runs` and the `pipeline_runs` view | Grafana, on-call | Exists |
| Staging, intermediate | `analytics` today, `staging` proposed | Typed views over each raw table, and `int_<chain>_balances`, which puts each chain in one shape | dbt only | Exists |
| Core | `core` | Every reading as a typed fact, plus asset, wallet and price tables | Analysts, the marts | Proposed |
| Marts | `analytics` today, `marts` proposed | `latest_balances`, `requested_balances` and `tokens`; daily balance and portfolio rollups | Finance, dashboards, the CSV | Partly |

dbt builds every model in `analytics` today. Separate schemas would let readers get grants on `marts` alone.

### What to keep from the source

Each raw row keeps the reply and the call that made it in `data` (`block_number` or `slot`, `wallet`, `token` or `mint`, `balance`), plus `_loaded_at`. The row `id` names the block, as in `<block>:<token>:<wallet>`, so each run at a new block adds a row and history stays. `raw.input_wallet_assets` keeps every input line as written, with its `load_id`, `line` and `problem`. `raw._dead_letters` keeps each failed `call` with its `error` and `attempts`. `ops.ingestion_runs` keeps each run's `run_id`, `dagster_run_id`, counts and error.

I would add:

- `_run_id` on every raw row. Today a row links to its run only by time, and a rerun at the same block overwrites `data` and `_loaded_at`. I would key raw rows on `(id, _run_id)` and only append, so two replies for one block both stay and any disagreement shows.
- `_upstream`, the RPC provider that answered. For EVM and Solana, eRPC names it in a response header. A wrong balance then points at one provider.
- `_block_time`, one extra call per block read, so daily cuts use chain time, not load time.
- The input file's SHA-256 and path on each `load_id`, so a report traces back to the exact file.
- `ops.call_failures`, an append-only copy of each dead letter. A success deletes its dead letter today, so only counts remain of past errors.

Solana and Bitcoin RPCs cannot serve past state, so raw is the only copy of a past balance on those chains. Keeping it means I can rebuild every downstream table after a fix without new RPC calls, and trace any number to its reply, provider and input line.

### Cleaned tables and rollups

- `core.fct_balance_snapshots` holds every reading, typed and scaled to whole tokens. `latest_balances` keeps only the newest, so today the history exists only as JSON in `raw`. Every question over time starts here.
- `core.dim_assets` extends `tokens` to native assets, whose decimals the intermediate models hard-code today, and maps each asset to a price feed id.
- `core.dim_wallets` holds the entity that owns each wallet and its tags. The input CSV has only addresses. Owners change, so rows carry `valid_from` and `valid_to`, and a past report keeps its past owner.
- `core.fct_asset_prices` holds one USD price per asset, day and price source, loaded by a new source. Keeping the price source lets anyone check a USD value.
- `marts.daily_balances` takes the last reading before each day ends, for each wallet and asset, with its USD value. Chains read at different blocks, and the day lines them up. A wallet asset with no new reading carries the old one with `is_stale` set, so a gap shows instead of a false zero.
- `marts.daily_portfolio` sums `daily_balances` by day, entity and asset: what each entity held and what it was worth.
- `latest_balances` and `requested_balances` stay as they are and feed the CSV.

dbt would build the facts and daily marts incrementally, one day at a time. On top of today's key, null, accepted-value and contract tests, I would add:

- a uniqueness test on each table's grain
- a test that every requested wallet asset has a reading from today
- a warning when a balance moves by more than a set share in one day
- dbt source freshness on `_loaded_at`

`ops.dbt_node_runs` already logs each test result, so one Grafana alert on it covers every test.

### Table grain

```sql
-- Grain: one row per reading per run. Today's raw table plus three columns, keyed by run too.
CREATE TABLE raw.ethereum_erc20_balances (
  id          text        NOT NULL,  -- '<block>:<token>:<wallet>'
  _run_id     uuid        NOT NULL,  -- ops.ingestion_runs.run_id
  data        jsonb       NOT NULL,  -- {block_number, token, wallet, balance}, balance as a string
  _upstream   text,
  _block_time timestamptz,
  _loaded_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, _run_id)
);

-- Grain: one row per chain, wallet, asset and block. When two runs read one block, the later wins.
CREATE TABLE core.fct_balance_snapshots (
  chain          text        NOT NULL,
  wallet         text        NOT NULL,
  asset          text        NOT NULL,  -- token address or mint; 'eth', 'sol' or 'btc' for native
  block_number   bigint      NOT NULL,  -- the slot on Solana
  block_time     timestamptz NOT NULL,
  balance        numeric     NOT NULL,  -- base units
  balance_tokens numeric,               -- null while the decimals are unknown
  run_id         uuid        NOT NULL,
  upstream       text,
  PRIMARY KEY (chain, wallet, asset, block_number)
);

-- Grain: one row per chain and asset, native assets included.
CREATE TABLE core.dim_assets (
  chain      text NOT NULL,
  asset      text NOT NULL,
  asset_type text NOT NULL,  -- native, erc20 or spl
  decimals   integer,        -- null when the contract does not say
  price_id   text,           -- the asset's id at the price source
  PRIMARY KEY (chain, asset)
);

-- Grain: one row per chain, wallet and period of ownership.
CREATE TABLE core.dim_wallets (
  chain      text   NOT NULL,
  wallet     text   NOT NULL,
  valid_from date   NOT NULL,
  valid_to   date,                         -- null for the current owner
  entity     text   NOT NULL,              -- the fund, desk or client that owns the wallet
  tags       text[] NOT NULL DEFAULT '{}', -- such as treasury, cold, exchange
  PRIMARY KEY (chain, wallet, valid_from)
);

-- Grain: one row per day, chain, wallet and asset.
CREATE TABLE marts.daily_balances (
  day            date        NOT NULL,  -- UTC
  chain          text        NOT NULL,
  wallet         text        NOT NULL,
  asset          text        NOT NULL,
  entity         text,                  -- the owner that day; null when none is on file
  balance_tokens numeric,
  value_usd      numeric,               -- balance_tokens times that day's price
  block_number   bigint      NOT NULL,  -- the last reading before the day ended
  block_time     timestamptz NOT NULL,
  is_stale       boolean     NOT NULL,  -- true when that reading is from an earlier day
  PRIMARY KEY (day, chain, wallet, asset)
);
```

## More docs

| Doc | Read it for |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Layout, data flow, the CLI, monitoring, adding a source or a pipeline |
| [GLOSSARY.md](GLOSSARY.md) | Terms: source, call, record, run, dead letter |
| [transformation/README.md](transformation/README.md) | The dbt models, and adding a chain to balances |
