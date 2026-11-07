# Metadata Sources Read the Wallet Asset CSV Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `evm-erc20-metadata` and `solana-spl-metadata` read the decimals of every token in `ingestion/wallet-assets.csv`, so each token a balance source reads has its decimals in `analytics.tokens`.

**Architecture:** Each metadata source reads the token addresses in its chain's token rows of the CSV (`ethereum` `erc20`, `solana` `spl`) through `readWalletAssets`, as the balance sources do, and adds the tokens in its `addresses.json`. `settleCalls` already makes each distinct call once, so a token that 50 wallets hold, or that both lists name, costs one call. `addresses.json` stays: Arbitrum and Base, which the CSV cannot hold yet, have no other list, and the blockjuice skill adds tokens there when an answer needs decimals that no balance needs. On such a chain the EVM source never opens the CSV.

**Tech Stack:** TypeScript on Node 24, the pnpm workspace in `ingestion/`, `@ingestion/lib/wallet-assets`, viem, `@solana/kit`, zod 4, `node:test` run by tsx; dbt on Postgres.

**Spec:**
- `/Users/ianguimaraes/Projects/am/take-home/description.md`: the input CSV of "blockchain, wallet address, and token address combinations", and the output column `balance_tokens` "(human-readable token units, adjusted for decimals)".
- The pattern: commit `927dde0`, which switched the five balance sources to the CSV. Read `ingestion/sources/evm-erc20-balances/src/source.ts` and its `source.test.ts`, and `ingestion/sources/solana-spl-balances/src/source.ts` and its `source.test.ts`.

## Setup

- [ ] Create the worktree with superpowers:using-git-worktrees: branch `feat/metadata-wallet-assets-csv` from `main`.
- [ ] From the worktree root, run `uv run --project orchestration bj install`. It copies the `.env` files, installs the pnpm packages and runs `dbt parse`.
- [ ] Record the baseline: `cd ingestion && pnpm typecheck && pnpm --filter @ingestion/evm-erc20-metadata test && pnpm --filter @ingestion/solana-spl-metadata test`. Note any failure that predates this work.
- [ ] This plan is not committed. Read it from the main checkout at `docs/superpowers/plans/2026-11-07-metadata-wallet-assets-csv.md`.

## Global Constraints

- The CSV path comes from `WALLET_ASSETS_CSV`, through `walletAssetsEnv` from `@ingestion/lib/wallet-assets`. Its default, `../../wallet-assets.csv`, resolves from the package folder, so an `.env` without the setting still works.
- Read the CSV and `addresses.json` inside `extract`, never at import, so `runSource` logs a bad file and `pnpm generate-sources` still imports every `source.ts`.
- Read the CSV first, then `addresses.json`. Records come out in that order, each token once.
- An EVM chain that `evmBlockchain` rejects (today every chain but `ethereum`) reads only its `addresses.json` and does not open the CSV. This differs from `evm-erc20-balances`, which fails such a run: a balance source has no other list, a metadata source does.
- A bad row fails a metadata run only when the run's own read picks it: `ethereum` `erc20` rows for `evm-erc20-metadata` on `ethereum`, `solana` `spl` rows for `solana-spl-metadata`. A bad native row, or a bad row on another chain, does not.
- No change to the call schemas, call ids, record shapes, `name` or `table`. Dead letters from earlier runs must still parse, and `ingestion/sources.json` must not change.
- `addresses.json` keeps its current contents and stays required.
- No new dependency. The only change in `ingestion/lib` is a doc comment.
- `ingestion/tsconfig.json` is strict, with `noUncheckedIndexedAccess` and `erasableSyntaxOnly`. Imports inside a package use `#src/<file>.ts`.
- Tests use `node:test` and `node:assert/strict`, as the existing `source.test.ts` files do.
- dbt commands run from the repo root after `set -a && . ./.env && set +a`, as `uv run --project orchestration dbt <command> --project-dir transformation --profiles-dir transformation`, written below as `dbt <command>`.
- Prose in comments, YAML descriptions and docs: short words, active voice, no stock phrases.

## Review Focus

1. A token that many wallets hold. USDC on Ethereum sits in 52 rows of the CSV, and Solana USDC in 71. Each should cost one call and give one record per run. Tests: Task 1 and Task 2, "reads each … once".
2. One Ethereum token written checksummed in `addresses.json` and lowercase in the CSV. It should cost one call. Test: Task 1, "reads each erc20 token … once".
3. A bad row that only another source reads, such as a bad native wallet or a bad Bitcoin address. The metadata run should still read its tokens. Tests: Task 1 and Task 2, folded into "reads each … once".
4. A Base or Arbitrum run when the CSV is missing or broken. It should read its `addresses.json` and succeed. Test: Task 1, "a chain the wallet asset CSV cannot hold reads only its addresses.json".
5. An `.env` written before this change, without `WALLET_ASSETS_CSV`. The run should find `ingestion/wallet-assets.csv` through the default. Checked by the live run in Task 3, which leaves `.env` as it is.

## Out of Scope

- Removing `addresses.json` from either metadata source, or trimming tokens the CSV already lists.
- Arbitrum and Base rows in the CSV. That needs `evmBlockchain` and the balance sources to take those chains.
- Computing `balance_tokens` and writing the output CSV.
- Running the `tokens` job when the CSV changes. A token added to the CSV gets its decimals at the next `tokens` run.

## File Structure

- Modify `ingestion/sources/evm-erc20-metadata/src/source.ts`: `forChain` reads the CSV's erc20 tokens, through a new private `csvTokens`.
- Modify `ingestion/sources/evm-erc20-metadata/src/source.test.ts`: the source-level tests at the bottom of the file.
- Modify `ingestion/sources/evm-erc20-metadata/.env.example`.
- Modify `ingestion/sources/solana-spl-metadata/src/source.ts`, `src/source.test.ts` and `.env.example`.
- Modify `ingestion/lib/src/wallet-assets/env.ts`: the doc comment names the metadata sources too.
- Modify the docs that say where the metadata sources get their tokens: `docs/architecture.md`, `README.md`, `.claude/skills/blockjuice/workflows/state-source.md`, `.claude/skills/blockjuice/workflows/answer.md`, and the two staging models' comments and YAML descriptions.

---

### Task 1: `evm-erc20-metadata` reads the CSV's erc20 tokens

**Files:**
- Modify: `ingestion/sources/evm-erc20-metadata/src/source.ts` (`forChain` and its doc comment, near the end)
- Modify: `ingestion/sources/evm-erc20-metadata/.env.example`
- Modify: `ingestion/lib/src/wallet-assets/env.ts:4-8` (doc comment)
- Modify: `docs/architecture.md:29`
- Modify: `transformation/models/staging/ethereum/stg_ethereum__erc20_metadata.sql:1`
- Modify: `transformation/models/staging/ethereum/_ethereum__models.yml:130-133`
- Test: `ingestion/sources/evm-erc20-metadata/src/source.test.ts`

**Interfaces:**
- Consumes, from `@ingestion/lib/wallet-assets`: `readWalletAssets(path, "ethereum", "erc20")`, which returns `{ walletAddress: Address; tokenAddress: Address }[]` with lowercase addresses; `evmBlockchain`, the zod enum `["ethereum"]`; `walletAssetsEnv` and `WalletAssetsEnv`.
- Produces: `forChain(chain: string): Source<EvmEnv & WalletAssetsEnv, MetadataCall>`. `chainName`, `metadataCallSchema`, `metadataCallsAt` and `fetchMetadata` keep their signatures.

- [ ] **Step 1: Write the failing tests**

In `src/source.test.ts`, replace everything from `const env = { BLOCK_NUMBER: …` through the test "malformed addresses.json fails the run, not the import" with the code below. Keep "each chain loads into a table of its own" as it is. The file's `node`, `answering` and `usdc` stay in use.

Add a helper `packageFolder(t: TestContext, chain: string, addresses: string, ...rows: string[]): Promise<string>`. It makes a temp folder laid out like the package, writes `addresses` to `chains/<chain>/addresses.json`, writes `blockchain,wallet_address,token_address` and then `rows`, one per line, to `wallet-assets.csv`, and `chdir`s into the folder until the test ends, as the old `addressesHold` did. It returns the CSV's absolute path. Copy `firstBatch(chain, settings)` from `evm-erc20-balances/src/source.test.ts` unchanged: it parses `BLOCK_NUMBER: "5"` and the settings through `source.env`, so no test needs a block from the node.

```ts
const wallet = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const otherWallet = "0x28C6c06298d514Db089934071355E5743bf21d60";
const dai = "0x6b175474e89094c44da98b954eedeac495271d0f";
const uni = "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984";
const baseUni = "0xc3de830ea07524a0761646a6a4e4be0e114a3c83";

test("reads each erc20 token in the wallet asset CSV and in addresses.json once", async (t) => {
  const csv = await packageFolder(
    t,
    "ethereum",
    JSON.stringify({ tokens: [getAddress(usdc), getAddress(uni)] }),
    `ethereum,${wallet},`,
    `ethereum,${wallet},${usdc}`,
    `ethereum,${otherWallet},${getAddress(usdc)}`,
    `ethereum,${wallet},${dai}`,
    // Bad rows that only evm-eth-balances and bitcoin-btc-balances read.
    "ethereum,0xnot,",
    "bitcoin,not-a-bitcoin-address,",
  );
  const { url } = await node(t, answering({}));

  const batch = await firstBatch("ethereum", { WALLET_ASSETS_CSV: csv, EVM_RPC_URL: url });

  assert.deepEqual(
    batch?.records.map(({ data }) => data.token),
    [usdc, dai, uni],
    "the CSV's tokens first, then addresses.json's, each once whatever its case",
  );
  assert.deepEqual(batch?.failed, []);
});

test("a bad erc20 row fails the run, not the import", async (t) => {
  const csv = await packageFolder(t, "ethereum", JSON.stringify({ tokens: [] }), `ethereum,${wallet},0xnot`);
  await assert.rejects(firstBatch("ethereum", { WALLET_ASSETS_CSV: csv }), {
    message: `Invalid ethereum erc20 rows in ${csv}:\n  line 2: token_address "0xnot" is not an Ethereum address; leave it empty for ETH`,
  });
});

test("a chain the wallet asset CSV cannot hold reads only its addresses.json", async (t) => {
  await packageFolder(t, "base", JSON.stringify({ tokens: [baseUni] }));
  const { url } = await node(t, answering({}));

  // No file is at this path, so the run fails if it opens the CSV.
  const batch = await firstBatch("base", { WALLET_ASSETS_CSV: "missing.csv", EVM_RPC_URL: url });

  assert.deepEqual(batch?.records.map(({ data }) => data.token), [baseUni]);
});

test("a bad address in addresses.json fails the run, not the import", async (t) => {
  const csv = await packageFolder(t, "ethereum", JSON.stringify({ tokens: ["0xnot-an-address"] }), `ethereum,${wallet},`);
  await assert.rejects(firstBatch("ethereum", { WALLET_ASSETS_CSV: csv }), {
    message: "Invalid Ethereum addresses:\n  0xnot-an-address",
  });
});

test("malformed addresses.json fails the run, not the import", async (t) => {
  const csv = await packageFolder(t, "ethereum", '{ "tokens": [], }', `ethereum,${wallet},`);
  await assert.rejects(firstBatch("ethereum", { WALLET_ASSETS_CSV: csv }), /chains\/ethereum\/addresses\.json is not valid JSON/);
});
```

The last two tests give the CSV a valid row because the reader fails a CSV with no rows, and the run reads the CSV first.

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd ingestion/sources/evm-erc20-metadata && pnpm test`
Expected: FAIL. "reads each erc20 token …" gets only `[usdc, uni]`, and "a bad erc20 row …" resolves instead of rejecting. The decoding tests above them still pass.

- [ ] **Step 3: Read the CSV in `forChain`**

In `src/source.ts`, add a private `csvTokens(path: string, chain: string): Address[]`: the chain's erc20 token addresses in the CSV, or `[]` when `evmBlockchain.safeParse(chain)` fails, without opening the file. Its doc comment says why a chain outside the CSV is not an error here: the chain still has `addresses.json`.

Change `forChain` to take `env: evmEnv.extend(walletAssetsEnv.shape)` and type `Source<EvmEnv & WalletAssetsEnv, MetadataCall>`, and build its tokens as `[...csvTokens(env.WALLET_ASSETS_CSV, chain), ...validateEthAddressList(list.tokens)]`. Leave the duplicates to `settleCalls`. Its doc comment starts: "The name, symbol and decimals of every token in the chain's erc20 rows of the wallet asset CSV and in chains/<chain>/addresses.json, at BLOCK_NUMBER, …" and keeps the rest.

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd ingestion/sources/evm-erc20-metadata && pnpm test`
Expected: PASS, every test.

- [ ] **Step 5: Set the CSV in `.env.example`, and say so in the docs**

In `.env.example`, end the header comment with "On Ethereum it also reads every token in the erc20 rows of WALLET_ASSETS_CSV." Before `PUSHGATEWAY_URL`, add the same two lines `evm-erc20-balances/.env.example` has, with its comment changed to: "# The wallet asset CSV the balance sources share, by its path from this package's folder. Chains it cannot hold yet, such as base, do not read it."

In `ingestion/lib/src/wallet-assets/env.ts`, the `walletAssetsEnv` comment starts: "The wallet asset CSV that the balance and metadata sources read, by its path from the source's package folder. The default is the one file they share, …".

In `docs/architecture.md:29`, after "an `addresses.json` that lists `tokens`.", add: "On Ethereum it also reads every token in the `erc20` rows of the wallet asset CSV, so each token a balance source reads has its decimals. Arbitrum and Base, which the CSV cannot hold yet, read only their `addresses.json`. A token in both lists is read once."

In `stg_ethereum__erc20_metadata.sql:1` and the `stg_ethereum__erc20_metadata` description in `_ethereum__models.yml`, replace "chains/ethereum/addresses.json of evm-erc20-metadata" (in the YAML, "evm-erc20-metadata's chains/ethereum/addresses.json") with "the ethereum erc20 rows of ingestion/wallet-assets.csv or evm-erc20-metadata's chains/ethereum/addresses.json". Wrap at the file's line width.

- [ ] **Step 6: Typecheck, and check that `sources.json` does not change**

Run: `cd ingestion && pnpm typecheck && pnpm generate-sources && git diff --exit-code sources.json`
Expected: no type errors, and no diff.

- [ ] **Step 7: Commit**

```bash
git add ingestion/sources/evm-erc20-metadata ingestion/lib/src/wallet-assets/env.ts docs/architecture.md \
  transformation/models/staging/ethereum/stg_ethereum__erc20_metadata.sql transformation/models/staging/ethereum/_ethereum__models.yml
git commit -m "$(cat <<'EOF'
feat(evm-erc20-metadata): read the erc20 tokens in the wallet asset CSV

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `solana-spl-metadata` reads the CSV's spl mints

**Files:**
- Modify: `ingestion/sources/solana-spl-metadata/src/source.ts`
- Modify: `ingestion/sources/solana-spl-metadata/.env.example`
- Modify: `docs/architecture.md:31`
- Modify: `transformation/models/staging/solana/stg_solana__spl_metadata.sql:1`
- Modify: `transformation/models/staging/solana/_solana__models.yml:26-29`
- Test: `ingestion/sources/solana-spl-metadata/src/source.test.ts`

**Interfaces:**
- Consumes, from `@ingestion/lib/wallet-assets`: `readWalletAssets(path, "solana", "spl")`, which returns `{ walletAddress: Address; tokenAddress: Address }[]` with addresses as written; `walletAssetsEnv` and `WalletAssetsEnv`.
- Produces: `solanaSplMetadata: Source<SolanaEnv & WalletAssetsEnv, MetadataCall>`. `metadata.ts` does not change.

- [ ] **Step 1: Write the failing tests**

In `src/source.test.ts`, replace `addressesHold` with `packageFolder(t: TestContext, addresses: string, ...rows: string[]): Promise<string>`: like Task 1's, with `addresses.json` at the folder's root. Copy `rpcAnswering(t, result)` from `solana-spl-balances/src/source.test.ts`. Change `firstBatch` to take the env: `(env: { SOLANA_RPC_URL: string; WALLET_ASSETS_CSV: string }) => solanaSplMetadata.extract(env, [])[Symbol.asyncIterator]().next()`. Then replace the two addresses.json tests with these, and keep "loads raw.solana_spl_metadata":

```ts
const wallet = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const otherWallet = "H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS";
const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const usdt = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const pyusd = "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo";
const unreachable = "http://127.0.0.1:1";

test("reads each spl mint in the wallet asset CSV and in addresses.json once", async (t) => {
  const csv = await packageFolder(
    t,
    JSON.stringify({ mints: [usdc, pyusd] }),
    `solana,${wallet},`,
    `solana,${wallet},${usdc}`,
    `solana,${otherWallet},${usdc}`,
    `solana,${wallet},${usdt}`,
    // A bad row that only solana-sol-balances reads.
    "solana,nope,",
  );
  // No account at the mint or its Metaplex address, so each mint reads as nulls.
  const url = await rpcAnswering(t, { context: { slot: 1 }, value: [null, null] });

  const { value: batch } = await firstBatch({ SOLANA_RPC_URL: url, WALLET_ASSETS_CSV: csv });

  assert.deepEqual(
    batch?.records.map(({ data }) => data.mint),
    [usdc, usdt, pyusd],
    "the CSV's mints first, then addresses.json's, each once",
  );
  assert.deepEqual(batch?.failed, []);
});

test("a bad spl row fails the run, not the import", async (t) => {
  const csv = await packageFolder(t, JSON.stringify({ mints: [] }), `solana,${wallet},nope`);
  await assert.rejects(firstBatch({ SOLANA_RPC_URL: unreachable, WALLET_ASSETS_CSV: csv }), {
    message: `Invalid solana spl rows in ${csv}:\n  line 2: token_address "nope" is not a Solana address; leave it empty for SOL`,
  });
});

test("a bad mint in addresses.json fails the run, not the import", async (t) => {
  const csv = await packageFolder(t, JSON.stringify({ mints: ["not-an-address"] }), `solana,${wallet},`);
  await assert.rejects(firstBatch({ SOLANA_RPC_URL: unreachable, WALLET_ASSETS_CSV: csv }), {
    message: "Invalid Solana addresses:\n  not-an-address",
  });
});

test("malformed addresses.json fails the run, not the import", async (t) => {
  const csv = await packageFolder(t, '{ "mints": [], }', `solana,${wallet},`);
  await assert.rejects(firstBatch({ SOLANA_RPC_URL: unreachable, WALLET_ASSETS_CSV: csv }), /addresses\.json is not valid JSON/);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd ingestion/sources/solana-spl-metadata && pnpm test`
Expected: FAIL. "reads each spl mint …" gets only `[usdc, pyusd]`, and "a bad spl row …" resolves instead of rejecting. The `metadata.test.ts` tests still pass.

- [ ] **Step 3: Read the CSV in `solanaSplMetadata`**

Set `env: solanaEnv.extend(walletAssetsEnv.shape)` and the type `Source<SolanaEnv & WalletAssetsEnv, MetadataCall>`. In `extract`, build the mints as the CSV's `solana` `spl` token addresses, then `validateSolanaAddressList(readJson("addresses.json").mints)`. Leave the duplicates to `settleCalls`. The comment above the export starts: "The decimals, names and symbols of every mint in the wallet asset CSV's solana spl rows and in addresses.json, …".

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd ingestion/sources/solana-spl-metadata && pnpm test`
Expected: PASS, every test.

- [ ] **Step 5: Set the CSV in `.env.example`, and say so in the docs**

In `.env.example`, before `PUSHGATEWAY_URL`, add `WALLET_ASSETS_CSV=../../wallet-assets.csv` with the comment "# The wallet asset CSV the balance sources share, by its path from this package's folder. This source reads the mints in its solana spl rows."

In `docs/architecture.md:31`, replace "its `addresses.json` lists `mints`, and each run reads" with "it reads the mints in the `spl` rows of the wallet asset CSV and in its `addresses.json`, each once, and each run reads".

In `stg_solana__spl_metadata.sql:1` and the `stg_solana__spl_metadata` description in `_solana__models.yml`, replace "solana-spl-metadata's addresses.json" with "the solana spl rows of ingestion/wallet-assets.csv or solana-spl-metadata's addresses.json". Wrap at the file's line width.

- [ ] **Step 6: Typecheck, and check that `sources.json` does not change**

Run: `cd ingestion && pnpm typecheck && pnpm generate-sources && git diff --exit-code sources.json`
Expected: no type errors, and no diff.

- [ ] **Step 7: Commit**

```bash
git add ingestion/sources/solana-spl-metadata docs/architecture.md \
  transformation/models/staging/solana/stg_solana__spl_metadata.sql transformation/models/staging/solana/_solana__models.yml
git commit -m "$(cat <<'EOF'
feat(solana-spl-metadata): read the spl mints in the wallet asset CSV

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Shared docs, and a live run that proves every CSV token has decimals

**Files:**
- Modify: `README.md:70`
- Modify: `.claude/skills/blockjuice/workflows/state-source.md:19`
- Modify: `.claude/skills/blockjuice/workflows/answer.md:33`

**Interfaces:**
- Consumes: Task 1's and Task 2's sources, `analytics.tokens` (`chain`, `token`, `decimals`).
- Produces: nothing new in code.

- [ ] **Step 1: Update the shared docs**

`README.md:70`: replace "Each balance source reads its own rows from it." with "Each balance source reads its own rows from it, and `evm-erc20-metadata` and `solana-spl-metadata` read the decimals of each token in it."

`state-source.md:19`: after "through `readWalletAssets`.", add "A metadata source reads the CSV's tokens as well as its `addresses.json`."

`answer.md:33`: before "A token missing there needs its address in …", add "Every token in `ingestion/wallet-assets.csv` is there once the `tokens` job has run."

- [ ] **Step 2: Run the orchestration tests that copy or list these packages**

Run: `cd orchestration && uv run pytest tests/test_cli_new_source.py tests/test_sources_json.py tests/test_definitions.py -q`
Expected: all pass. `bj new-source --like evm-erc20-metadata` still copies `chains/<chain>/addresses.json`.

- [ ] **Step 3: Run both sources once, with `.env` as `bj install` left it**

Start the stack with `docker compose up -d`. Do not add `WALLET_ASSETS_CSV` to either `.env`: the run must find the file through the default.

Run: `cd ingestion/sources/evm-erc20-metadata && CHAIN=ethereum pnpm ingest`, then `cd ../solana-spl-metadata && pnpm ingest`
Expected: both exit 0. Each logs the CSV's warnings, if any, and no error.

- [ ] **Step 4: Build `analytics.tokens` and look for CSV tokens without decimals**

From the repo root:

```bash
set -a && . ./.env && set +a
dbt build --select +tokens
DB="postgresql://$WAREHOUSE_USER:$WAREHOUSE_PASSWORD@$WAREHOUSE_HOST:$WAREHOUSE_PORT/$WAREHOUSE_DB"
{
  echo "create temp table wanted (chain text, token text);"
  echo "copy wanted from stdin with (format csv);"
  awk -F, 'NR > 1 && $3 != "" { print $1 "," ($1 == "ethereum" ? tolower($3) : $3) }' ingestion/wallet-assets.csv | sort -u
  printf '%s\n' '\.'
  echo "select w.chain, w.token from wanted w left join analytics.tokens t using (chain, token) where t.decimals is null order by 1, 2;"
  echo "select source_table, count(*) from raw._dead_letters where source_table in ('ethereum_erc20_metadata', 'solana_spl_metadata') and not parked group by 1;"
} | psql "$DB"
```

Expected: dbt ends with `Completed successfully`, ERROR=0. psql prints `COPY 24` (15 Ethereum tokens and 9 Solana mints), then `(0 rows)` for both queries.

A token in the first result with a raw row but null decimals has a contract that does not say; report it, do not change the code. A token with no raw row at all is a bug in Task 1 or Task 2. A dead letter is an RPC failure: run the source again and check that it clears.

- [ ] **Step 5: Commit**

```bash
git add README.md .claude/skills/blockjuice/workflows/state-source.md .claude/skills/blockjuice/workflows/answer.md
git commit -m "$(cat <<'EOF'
docs: say the metadata sources read the tokens in the wallet asset CSV

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```
