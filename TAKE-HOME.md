# Wallet balances take-home

## What it does

BlockJuice reads a CSV of wallet and asset pairs on Ethereum, Solana and Bitcoin, and fetches each balance over RPC.
TypeScript sources load the readings into Postgres, dbt keeps each pair's latest balance, and Dagster runs both as the `balances` job.
The output is a CSV with one row per input row and the balance in whole tokens.

[docs/recurring-job.md](docs/recurring-job.md) explains how this would run as a daily job: the data layers, the metadata to keep, the tables and their grain, and the schedule, retries and alerts.

## Configure

You need Node 24 and pnpm 10.17.0 (`mise install` sets up both from `mise.toml`), [uv](https://docs.astral.sh/uv/) and Docker. Run every command from the repo root.

### Create the .env files

```sh
uv run --project orchestration bj install
```

`bj install` copies each missing `.env` from its `.env.example`: the root `.env` and one in each source package. It never overwrites an `.env`. It also installs the Node packages in `ingestion/` and runs `dbt parse`. Git ignores every `.env`.

The defaults work as they are. These are the settings the balances job reads:

| File | Setting | Default | What it sets |
|---|---|---|---|
| `.env` | `WAREHOUSE_HOST`, `WAREHOUSE_PORT`, `WAREHOUSE_USER`, `WAREHOUSE_PASSWORD`, `WAREHOUSE_DB` | `localhost`, `5432`, `elt`, `elt`, `warehouse` | The Postgres warehouse that Docker starts |
| `.env` | `ERPC_PORT`, `DSHACKLE_PORT`, `GRAFANA_PORT` | `4000`, `8545`, `3001` | The host ports of eRPC, Dshackle and Grafana |
| `.env` of each balance source | `WALLET_ASSETS_CSV` | `../../wallet-assets.csv` | The input CSV, by its path from the package folder |
| `.env` of `evm-eth-balances` and `evm-erc20-balances` | `BLOCK_NUMBER` | `finalized` | The block to read: a number, or `latest`, `safe` or `finalized` |
| `chains/ethereum/.env.example` of the same two packages | `EVM_RPC_URL`, `RPC_BATCH_SIZE` | `https://eth.drpc.org`, `3` | The Ethereum RPC, and the calls in one JSON-RPC batch |
| `.env` of `solana-sol-balances` and `solana-spl-balances` | `SOLANA_RPC_URL` | `http://localhost:4000/main/solana` | eRPC's Solana endpoint |
| `.env` of `bitcoin-btc-balances` | `DSHACKLE_URL` | `http://localhost:8545/bitcoin` | Dshackle's Bitcoin endpoint |

The source packages are in `ingestion/sources/`. An EVM source reads its settings in this order, and the first value wins: the environment, `chains/ethereum/.env`, `chains/ethereum/.env.example`, then the package `.env`. So to change `EVM_RPC_URL`, create `chains/ethereum/.env`. The same setting in the package `.env` has no effect.

### Choose RPC endpoints

The defaults need no API keys:

- eRPC (`infra/erpc/erpc.yaml`) sends Ethereum and Solana calls to free public endpoints, with retries, failover between them and a cache. The Solana sources read through it.
- Dshackle (`infra/dshackle/dshackle.yaml`) does the same for Bitcoin. The Bitcoin source reads through it.
- The two Ethereum sources skip eRPC and call `https://eth.drpc.org` directly. To send them through eRPC, set `EVM_RPC_URL=http://localhost:4000/main/evm/1` in `chains/ethereum/.env` of `evm-eth-balances` and `evm-erc20-balances`.

To use a provider key, such as a QuickNode or Alchemy endpoint, put the endpoint URL in the `.env` that sets `EVM_RPC_URL` or `SOLANA_RPC_URL`. Git ignores it, so the key stays out of the repo. A Bitcoin endpoint must serve `scantxoutset`. Of the free endpoints in `dshackle.yaml`, only OnFinality does.

### Start the stack

```sh
docker compose up -d
uv run --project orchestration bj doctor
```

`docker compose up -d` starts the Postgres warehouse, eRPC, Dshackle, Prometheus, the Pushgateway and Grafana. Run it from the repo root, not from `infra/`. `bj doctor` checks the `.env` files, the ports, the warehouse, eRPC and Dshackle, and exits 1 when a check fails.

To get the Dagster UI too, run `uv run --project orchestration bj dev` instead. It runs `bj install`, `docker compose up -d` and the checks, then starts Dagster at http://localhost:3000.

## Run

The shortest path from input CSV to output CSV:

1. Put your rows in `ingestion/wallet-assets.csv`. To read another file, set its absolute path in the environment: `export WALLET_ASSETS_CSV=/path/to/wallets.csv`. The environment wins over every `.env`, and a relative path would resolve from each package's own folder.
2. Read token decimals:

   ```sh
   uv run --project orchestration bj run tokens
   ```

3. Read the balances:

   ```sh
   uv run --project orchestration bj run balances
   ```

   It prints `balances: run <run id> succeeded`, or names each step that failed. The five balance sources load `raw.*_balances`, and dbt rebuilds `analytics.latest_balances`.

4. Write the output CSV:

   ```sh
   TODO(csv-out): the command that writes the output CSV
   ```

TODO(csv-out): the output path, and the example output file for `ingestion/wallet-assets.csv`.

TODO(csv-out): the output columns, in order, with a one-line meaning each.

To see the balances before the output step, query the mart. It holds base units, not whole tokens:

```sh
docker compose exec warehouse psql -U elt -d warehouse -c 'select * from analytics.latest_balances limit 10'
```

## Input format

The input is a CSV file with a header row. It needs three columns, in any order. The reader ignores any other column.

| Column | Value |
|---|---|
| `blockchain` | `ethereum`, `solana` or `bitcoin`, in lowercase |
| `wallet_address` | An Ethereum `0x` address in any case, a Solana base58 address, or a Bitcoin mainnet address (P2PKH, P2SH, P2WPKH, P2WSH or P2TR) |
| `token_address` | Empty for the native asset (ETH, SOL or BTC). Otherwise the ERC-20 contract or the SPL mint. Bitcoin rows leave it empty. |

Save the file as UTF-8 without a byte order mark. Any line ending works.

```csv
blockchain,wallet_address,token_address
ethereum,0x47ac0Fb4F2D84898e4D9E7b4DaB3C24507a6D503,0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
solana,GoGoGo6N99mpyB7rfzhw2R4fXmaFctURXHaHMoGCyoLD,
bitcoin,3DTxtzoqm1vb9RHVXQWStRZZc69zUT2WRB,
```

The first row asks for the USDC balance of an Ethereum wallet. The other two ask for native SOL and BTC.

`ingestion/wallet-assets.csv` is the example input: 250 wallets in 971 rows. It has 100 Ethereum wallets with 388 ERC-20 pairs, 90 Solana wallets with 333 SPL pairs, and 60 Bitcoin wallets.

## Assumptions, dependencies and limits

### Dependencies

- Node 24, pnpm 10.17.0, uv and Docker.
- Docker images: Postgres 16, eRPC 0.5.0, Dshackle 0.18.0, Prometheus, the Pushgateway, postgres-exporter and Grafana. Dshackle publishes an amd64 image only, so an arm64 host runs it under emulation.
- uv installs Dagster and dbt-postgres from `orchestration/pyproject.toml`.
- Free public RPC endpoints. `erpc.yaml` and `dshackle.yaml` list the ones that answered when tested on 2026-11-04. A public endpoint can change its limits or shut down at any time.

### Rate limits of free endpoints

- Solana. The Solana Foundation documents 100 requests per 10 seconds per IP. eRPC caps `getTokenAccountsByOwner` at 10 calls a minute on the Foundation's endpoints and at 1 call a second on the other endpoint that serves it. The SPL source reads one wallet and mint per call, 2 at a time. Those caps allow about 70 calls a minute, so the example's 333 SPL pairs need at least 5 minutes. That figure is an estimate from the caps, not a measurement.
- Bitcoin. One `scantxoutset` call reads every wallet. Only OnFinality serves it for free, at about 1 call every 3 seconds. A scan took 43 to 96 seconds when measured on 2026-11-04.
- Ethereum. drpc's free plan allows 3 calls per JSON-RPC batch, which is why `RPC_BATCH_SIZE` is 3. The ERC-20 source merges `balanceOf` calls into Multicall3 calls.

A call that fails after its retries does not fail the run. The source writes the other rows and stores the call in `raw._dead_letters`. The next run retries it. After 5 failed runs the source parks the call, and it waits for a person.

### Latest balances only

Each run reads balances as they are now. No source reads history.

- Ethereum reads at `BLOCK_NUMBER`, the latest finalized block by default. A past block number needs an archive node.
- Solana reads at the latest finalized slot. A Solana RPC cannot read a past slot.
- Bitcoin reads the UTXO set at the chain tip, so it counts confirmed coins only.

The three chains are read at different moments. The `block_number` of each row in `analytics.latest_balances` says where: the block on Ethereum, the slot on Solana and the height on Bitcoin.

`analytics.latest_balances` keeps every pair that any run loaded. A pair you remove from the CSV keeps its last balance there.

### Bad input rows

Each source reads only its own rows: Ethereum native, ERC-20, Solana native, SPL or Bitcoin. A bad row fails only the source that reads it, and the other sources still run.

- A problem with the whole file fails all five sources. These problems are a missing or empty file, a byte order mark, no data rows, a missing or repeated column, and text that is not valid CSV.
- A row fails its source when it has the wrong number of cells, a wallet or token that is not an address on its chain, or a token on a Bitcoin row. The error names every bad line.
- A row whose `blockchain` is not `ethereum`, `solana` or `bitcoin` logs a warning. No source reads it.
- A repeated wallet and token logs a warning, and the source reads it once.

A source that fails writes nothing, and the job does not rebuild `latest_balances` that run. The mart keeps its last build.

An ERC-20 `balanceOf` that reverts, such as on an address that is not a token contract, gives no balance and no error. That pair is missing from `latest_balances`.

### Where decimals come from

- Native assets have fixed decimals: 18 for ETH, 9 for SOL and 8 for BTC.
- ERC-20 and SPL decimals come from `analytics.tokens`, which the `tokens` job builds. `evm-erc20-metadata` calls each token's `decimals()`. `solana-spl-metadata` reads each mint.
- Today these two sources read their token lists from their own `addresses.json`, not from the input CSV. Those lists hold 4 ERC-20 tokens and 3 SPL mints. The example CSV has 15 and 9.
- A token with no row in `analytics.tokens`, or whose contract has no `decimals()`, has no known decimals. Nothing assumes 18.

TODO(csv-out): what `balance_tokens` holds when a token's decimals are unknown.

### Run time

TODO(run-time): the time a full run of `ingestion/wallet-assets.csv` takes, from input CSV to output CSV.
