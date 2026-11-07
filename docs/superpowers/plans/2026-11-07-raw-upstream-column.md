# Raw `_upstream` Column Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `_upstream` column to every raw table, and fill it for the Solana and EVM call sources with the eRPC upstream that answered each row's requests, so anyone reading a balance, code or metadata row can tell which RPC served it.

**Architecture:** A reply's upstream reaches its record through `AsyncLocalStorage`. The EVM and Solana clients pass each HTTP response to `noteResponse`. `withUpstream` runs a read and returns its value with the one upstream that every successful reply inside the read named, or null when they disagree or eRPC answered from its cache. `settleCalls` wraps every read in `withUpstream` and puts the upstream on its record, and the warehouse writes it to `_upstream`. eRPC names the winning upstream once per HTTP request, never per item of a JSON-RPC batch (measured below). viem's automatic Multicall3 merge has the same problem, because one merged call answers many rows. So the EVM client turns off both, and every read goes out as its own request. Nearly all of the change lives in `ingestion/lib`. In `sources/`, `solana-sol-balances` puts the upstream on its rows, and the two ERC-20 sources change how they recognise a revert, because their current check only works inside a Multicall3 batch.

**Tech Stack:** TypeScript on Node 24 in the pnpm workspace `ingestion/`, viem 2.57.16, `@solana/kit` 8.6.0, zod 4, `node:test` run by tsx, PGlite for warehouse tests, eRPC 0.5.0 (`infra/erpc/erpc.yaml`), Prometheus, pytest in `orchestration/`.

**Spec:** No design doc exists. The plan argues from:
- The request of 2026-11-07: "for the solana and evm raw tables I need to add a new column called source. Which means what RPC served that request." The user then chose the name `_upstream`, because `GLOSSARY.md` already defines **Source** as "a package that reads one kind of data from one origin and fills one raw table". The user also chose to turn off the Multicall3 merge rather than rewrite the ERC-20 sources around explicit groups.
- `/Users/ianguimaraes/Projects/am/take-home/description.md`, line 27: "What source data and collection metadata would you retain?"
- The probes in **Facts checked against eRPC**.

## Setup

- [ ] Create the worktree for branch `feat/raw-upstream-column` from `main` with superpowers:using-git-worktrees.
- [ ] From the worktree root, run `uv run --project orchestration bj install`.
- [ ] Start the stack with `docker compose up -d`. To check that eRPC names its upstream, run `curl -si localhost:4000/main/evm/1 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' | grep -i x-erpc-upstreams`. It prints one line ending in `:won`. If it does not, fix eRPC (`docker compose logs erpc`). Never point a source at a public RPC instead.
- [ ] Record the baseline: `cd ingestion && pnpm typecheck && pnpm -r test`, then `cd orchestration && uv run pytest -q`. Note any failure that predates this work.
- [ ] This plan is not committed. Read it from the main checkout at `docs/superpowers/plans/2026-11-07-raw-upstream-column.md`.

## Facts checked against eRPC

Measured on 2026-11-07 with curl against the stack's eRPC 0.5.0.

| Request | Headers that came back |
|---|---|
| `getSlot` to `/main/solana` | `X-Erpc-Upstreams: sol-publicnode=primary:success:158ms:won`, `X-Erpc-Cache: MISS` |
| `eth_getBalance` at a finalized block to `/main/evm/1`, first time | `X-Erpc-Upstreams: eth-publicnode=primary:client_error:148ms;eth-publicnode=retry:client_error:159ms;eth-blastapi=retry:success:167ms:won`, `X-Erpc-Cache: MISS` |
| The same request again | `X-Erpc-Cache: HIT`, `X-Erpc-Attempts: 0`, no `X-Erpc-Upstreams` |
| A JSON-RPC batch of three `eth_getBalance` at that block, one already cached | `X-Erpc-Cache: PARTIAL:1` and a single `X-Erpc-Upstreams` that lists six attempts with two `:won` entries and no JSON-RPC id |
| Any request to Dshackle at `localhost:8545/bitcoin` | No `x-erpc-*` header and no other header that names an upstream |

So the winner is the entry that ends in `:won`, and its id is the text before `=`. A cache hit names no upstream. A batch reply cannot say which item each upstream answered.

One fact is not measured yet. Nobody has checked what eRPC returns for an `eth_call` that reverts, because the stack was down when this plan was revised. Task 4 Step 1 measures it before any EVM code changes.

Facts about the code, read on 2026-11-07:

- `createEvmClient` (`ingestion/lib/src/evm/client.ts`) sends up to `RPC_BATCH_SIZE` calls per HTTP request. Its `batch: { multicall: { deployless: true } }` merges every `readContract` and `call` started in one tick into `aggregate3` calls of about 1,024 bytes of calldata each.
- `evm-erc20-balances` and `evm-erc20-metadata` treat a revert as a fact (a null value) and a failed request as a failure to retry. Their `revertedAtBlock` checks match `RawContractError` and `ContractFunctionZeroDataError`, which their comments say viem raises "only for one call's own result inside a Multicall3 batch". Their tests fake the RPC by decoding `aggregate3` calldata, and one test case treats a JSON-RPC `execution reverted` (code 3) as a failed batch.
- The sources read little. `evm-erc20-balances` reads 3 wallets times 3 tokens on Ethereum. `evm-erc20-metadata` reads 4 tokens on Ethereum, 1 on Arbitrum and 1 on Base. Multicall3 saves few requests at this size.
- `@solana/kit` 8.6.0's `createDefaultRpcTransport` takes no `fetch` and returns parsed JSON without headers. `@solana/rpc-spec-types` 8.6.0 exports `parseJsonWithBigInts` and `stringifyJsonWithBigInts`, the parsers kit's transport uses.
- `chains/ethereum/.env.example` in `evm-eth-balances`, `evm-erc20-balances` and `evm-erc20-metadata` sets `EVM_RPC_URL=https://eth.drpc.org`, which skips eRPC.
- Prometheus scrapes eRPC (`infra/prometheus/prometheus.yml`, job `erpc`), and `erpc_upstream_request_total` carries an `upstream` label (`infra/grafana/dashboards/erpc.json`).

## Global Constraints

- SQL column `_upstream text`, null allowed, on every raw table. The shared DDL in `ingestion/lib/src/warehouse/index.ts` adds it. In TypeScript the field is `upstream`. Never name either one `source`.
- `_upstream` holds the eRPC upstream `id` from `infra/erpc/erpc.yaml`, such as `eth-blastapi` or `sol-publicnode`. When a reply has no `x-erpc-*` header at all, it holds the host of the RPC URL, such as `eth.drpc.org`. It is null when the successful replies inside one read name different upstreams, when any of them came from eRPC's cache, and for every source whose client reports nothing: Portal streams, Bitcoin through Dshackle, and the candle sources. Null means unknown. The column never names an upstream that did not answer.
- The EVM client sends one JSON-RPC request per HTTP request and never merges reads into Multicall3.
- Rewriting a row keeps a known upstream over null: `_upstream = coalesce(excluded._upstream, t._upstream)`.
- Live runs read through eRPC: Ethereum `http://localhost:4000/main/evm/1`, Arbitrum `http://localhost:4000/main/evm/42161`, Base `http://localhost:4000/main/evm/8453`, Solana `http://localhost:4000/main/solana`. Never plan or configure a public RPC fallback.
- In `sources/`, code changes only where this plan names them: `solana-sol-balances/src/balances.ts`, and `revertedAtBlock` plus its comments in the two ERC-20 sources. Their tests change to match. Removing the dead `RPC_BATCH_SIZE` setting is the only other edit there.
- One new dependency only: `@solana/rpc-spec-types` `^8.6.0` in `ingestion/lib`, the version `@solana/kit` already installs.
- A Solana HTTP error still throws `SolanaError` with code `SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR`, so `withRetry` in `lib/src/solana/client.ts` still skips it. eRPC has already retried across its upstreams by then.
- `ingestion/tsconfig.json` is strict, with `noUncheckedIndexedAccess` and `erasableSyntaxOnly`. Imports inside a package use `#src/<file>.ts`.
- Tests use `node:test` and `node:assert/strict`. RPC tests run a local HTTP JSON-RPC server, like `fakeRpc` in `lib/src/evm/client.test.ts`. Warehouse tests use `lib/src/warehouse/pglite.fixture.ts`.
- Prose in doc comments, YAML and docs: short words, active voice, no stock phrases.

## Review Focus

1. A rerun at the same block, which eRPC answers from its cache, keeps the upstream the first run stored. It must not overwrite it with null. Task 2 tests it.
2. A raw table created before this change gets the column on its next run, and its old rows read null. Task 2 tests it.
3. Reads waiting in a client's concurrency queue each keep their own upstream. A leak would put one call's upstream on another call's row with no error. Task 1 tests it.
4. A lamport balance above 2^53 comes back exact through the new Solana transport. Task 3 tests it.
5. A token whose `balanceOf`, `name` or `symbol` reverts at the requested block still records a null value, not a failed call, now that the revert comes back as a JSON-RPC error on its own `eth_call`. Task 4 tests it.

## Out of Scope

- Portal stream tables (`evm-erc20-transfers`, `evm-uniswap-v2`, `-v3`, `-v4`, `evm-chainlink-price-feeds`, `evm-op-standard-bridge`, `arbitrum-token-bridge`). Their rows come from SQD Portal, not an RPC. They get the column, and it stays null.
- `bitcoin-btc-balances`. Dshackle sends no header that names the upstream. Its request log can, in a separate change.
- Pointing the three Ethereum `.env.example` files at eRPC. Rows read through them record `eth.drpc.org`. That is a separate change.
- Multicall3 groups built by the sources. They would cut upstream requests for long token lists. At today's 9 balance reads and 6 tokens they save little.
- dbt. Staging models select columns by name, so nothing downstream changes. Passing `_upstream` through staging, and adding it to the `bj new-source` scaffold, waits for a model that needs it.
- The upstream of a failed call. Dead letters keep only the error.
- Backfill. eRPC kept no record of who served old rows, so they stay null.
- `solana-spl-metadata` (branch `feat/solana-spl-metadata`, not merged). It reads through `settleCalls` with one `getMultipleAccounts` request per mint, so it gets `_upstream` with no change. Whichever branch merges second runs its tests again.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `ingestion/lib/src/upstream.ts`, `upstream.test.ts` | Create | `upstreamOf`, `noteResponse`, `withUpstream` |
| `ingestion/lib/src/source.ts` | Modify | `RawRecord.upstream` |
| `ingestion/lib/src/calls.ts`, `calls.test.ts` | Modify | `settleCalls` sets `upstream` |
| `ingestion/lib/src/index.ts` | Modify | Export the new names |
| `ingestion/lib/src/warehouse/index.ts`, `warehouse.test.ts` | Modify | `_upstream` column, insert, coalesce |
| `GLOSSARY.md` | Modify | Add **Upstream** |
| `ingestion/lib/package.json`, `ingestion/pnpm-lock.yaml` | Modify | `@solana/rpc-spec-types` |
| `ingestion/lib/src/solana/client.ts`, `client.test.ts` | Modify | A transport that reads headers |
| `ingestion/sources/solana-sol-balances/src/balances.ts`, `balances.test.ts` | Modify | Upstream on each row of a `getMultipleAccounts` call |
| `ingestion/lib/src/evm/client.ts`, `env.ts`, `client.test.ts` | Modify | Each read alone; note each reply; no `RPC_BATCH_SIZE` |
| `ingestion/sources/evm-erc20-balances/src/balances.ts`, `balances.test.ts` | Modify | Revert check for a lone `eth_call`; fake RPC answers lone calls |
| `ingestion/sources/evm-erc20-metadata/src/source.ts`, `source.test.ts` | Modify | Same |
| `ingestion/sources/evm-*/src/source.test.ts`, `ingestion/sources/evm-*/**/.env.example` | Modify | Drop `RPC_BATCH_SIZE` |
| `orchestration/pipeline/cli/doctor.py`, `orchestration/tests/test_cli_doctor.py` | Modify | Drop `RPC_BATCH_SIZE` |

---

### Task 1: Carry each read's upstream to its record

**Files:**
- Create: `ingestion/lib/src/upstream.ts`, `ingestion/lib/src/upstream.test.ts`
- Modify: `ingestion/lib/src/source.ts`, `ingestion/lib/src/calls.ts`, `ingestion/lib/src/calls.test.ts`, `ingestion/lib/src/index.ts`

**Interfaces:**
- Consumes: `createLimiter` from `#src/concurrency.ts`.
- Produces:
  - `upstreamOf(url: string, headers: Headers): string | null`
  - `noteResponse(url: string, response: Response): void`. It ignores a response that is not OK, since that reply carried no data.
  - `withUpstream<T>(read: () => Promise<T>): Promise<{ value: T; upstream: string | null }>`
  - `RawRecord` gains `upstream?: string | null`, with the doc comment "The RPC upstream that answered the requests this record came from. Null or absent when unknown."
  - `settleCalls` keeps its signature. Each record it makes carries `upstream`.
  - All of these are exported from `@ingestion/lib`.

- [ ] **Step 1: Write the failing tests for the header rules and the context**

In `upstream.test.ts`, with `const ERPC = "http://localhost:4000/main/evm/1"` and `const won = (id: string) => new Response(null, { headers: { "x-erpc-upstreams": `${id}=primary:success:1ms:won` } })`:

```ts
test("the upstream that eRPC marks :won answered", () => {
  const headers = new Headers({
    "x-erpc-upstreams":
      "eth-publicnode=primary:client_error:148ms;eth-publicnode=retry:client_error:159ms;eth-blastapi=retry:success:167ms:won",
  });
  assert.equal(upstreamOf(ERPC, headers), "eth-blastapi");
});

test("an eRPC cache hit names no upstream", () => {
  assert.equal(upstreamOf(ERPC, new Headers({ "x-erpc-cache": "HIT", "x-erpc-attempts": "0" })), null);
});

test("a reply that names two winners names none", () => {
  const headers = new Headers({ "x-erpc-upstreams": "a=primary:success:1ms:won;b=primary:success:2ms:won" });
  assert.equal(upstreamOf(ERPC, headers), null);
});

test("a reply from an RPC with no eRPC in front names its host", () => {
  assert.equal(upstreamOf("https://eth.drpc.org", new Headers({ "content-type": "application/json" })), "eth.drpc.org");
});

test("a read whose replies all name one upstream gets it", async () => {
  const { upstream } = await withUpstream(async () => {
    noteResponse(ERPC, won("a"));
    noteResponse(ERPC, won("a"));
  });
  assert.equal(upstream, "a");
});

test("a read whose replies name different upstreams gets null", async () => {
  const { upstream } = await withUpstream(async () => {
    noteResponse(ERPC, won("a"));
    noteResponse(ERPC, won("b"));
  });
  assert.equal(upstream, null);
});

test("a read with a reply from eRPC's cache gets null", async () => {
  const { upstream } = await withUpstream(async () => {
    noteResponse(ERPC, won("a"));
    noteResponse(ERPC, new Response(null, { headers: { "x-erpc-cache": "HIT" } }));
  });
  assert.equal(upstream, null);
});

test("a failed HTTP reply does not count", async () => {
  const { upstream } = await withUpstream(async () => {
    noteResponse(ERPC, new Response(null, { status: 503, headers: { "x-erpc-upstreams": "b=primary:server_error:1ms" } }));
    noteResponse(ERPC, won("a"));
  });
  assert.equal(upstream, "a");
});

test("each read keeps its own upstream, even queued behind a limiter", async () => {
  const limit = createLimiter(1);
  const read = (id: string) =>
    withUpstream(() =>
      limit(async () => {
        await setTimeout(1);
        noteResponse(ERPC, won(id));
        return id;
      }),
    );
  assert.deepEqual(await Promise.all(["a", "b", "c"].map(read)), [
    { value: "a", upstream: "a" },
    { value: "b", upstream: "b" },
    { value: "c", upstream: "c" },
  ]);
});

test("a read that notes no reply has no upstream", async () => {
  assert.deepEqual(await withUpstream(async () => 1), { value: 1, upstream: null });
});

test("a reply noted outside withUpstream changes nothing", () => {
  assert.doesNotThrow(() => noteResponse(ERPC, won("a")));
});
```

- [ ] **Step 2: Write the failing test for `settleCalls`**

In `calls.test.ts`, add `settleCalls puts each read's upstream on its record`. Three calls whose reads call `noteResponse` with replies naming `up-a`, `up-b` and `up-c`. Assert `batch.records.map((r) => r.upstream)` is `["up-a", "up-b", "up-c"]`.

- [ ] **Step 3: Run the tests to see them fail**

Run: `cd ingestion && pnpm --filter @ingestion/lib test`
Expected: FAIL. `upstream.ts` does not exist.

- [ ] **Step 4: Implement `upstream.ts`**

One module-level `AsyncLocalStorage` whose store collects the `upstreamOf` value of each OK reply noted inside the read. `withUpstream` runs `read` in a fresh store. Once `read` resolves, it returns the collected value when there is exactly one distinct value and it is not null, and null otherwise. `noteResponse` does nothing outside a store or for a response that is not OK. `upstreamOf` applies these rules in order:

1. `x-erpc-upstreams` present: split on `;`, keep the entries that end in `:won`, take the text before the first `=`. Exactly one distinct id gives that id. Anything else gives null.
2. Any other header whose name starts with `x-erpc-`: null.
3. No `x-erpc-*` header: `new URL(url).host`.

- [ ] **Step 5: Implement the record changes**

Add `upstream` to `RawRecord` in `source.ts` as the Interfaces block says. In `calls.ts`, `settleCalls` wraps each `read(call)` in `withUpstream`, still starting every read in the same tick, and puts `upstream` on the record. Export `upstreamOf`, `noteResponse` and `withUpstream` from `src/index.ts`.

- [ ] **Step 6: Run the tests to see them pass**

Run: `cd ingestion && pnpm --filter @ingestion/lib test && pnpm typecheck`
Expected: PASS, with no type errors.

- [ ] **Step 7: Commit**

```bash
git add ingestion/lib/src/upstream.ts ingestion/lib/src/upstream.test.ts ingestion/lib/src/source.ts ingestion/lib/src/calls.ts ingestion/lib/src/calls.test.ts ingestion/lib/src/index.ts
git commit -m "feat(lib): carry each read's RPC upstream to its record"
```

### Task 2: Write `_upstream` to every raw table

**Files:**
- Modify: `ingestion/lib/src/warehouse/index.ts`, `ingestion/lib/src/warehouse/warehouse.test.ts`, `GLOSSARY.md`

**Interfaces:**
- Consumes: `RawRecord.upstream` from Task 1.
- Produces: column `_upstream text` on `<RAW_SCHEMA>.<table>`. Task 5 queries it.

- [ ] **Step 1: Write the failing tests**

In `warehouse.test.ts`, with the PGlite fixture:

- `a new raw table has _upstream, filled from each record`: load `{ id: "1", upstream: "eth-blastapi" }` and `{ id: "2" }`. Assert `select id, _upstream ... order by id` returns `[{ id: "1", _upstream: "eth-blastapi" }, { id: "2", _upstream: null }]`.
- `a table made before _upstream gets the column when opened, and old rows read null`: create the table with the old DDL (`id text primary key, data jsonb not null, _loaded_at timestamptz not null default now()`), insert one row, then `open` it. Assert that row's `_upstream` is null and a new load fills the column.
- `rewriting a row with no upstream keeps the stored one`: load `{ id: "1", upstream: "eth-blastapi", data: { v: 1 } }`, then `{ id: "1", upstream: null, data: { v: 2 } }`. Assert `_upstream` is `"eth-blastapi"` and `data` is `{ v: 2 }`.
- `rewriting a row with a new upstream replaces it`: then load `{ id: "1", upstream: "eth-publicnode" }`. Assert `_upstream` is `"eth-publicnode"`.

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd ingestion && pnpm --filter @ingestion/lib test`
Expected: FAIL with `column "_upstream" does not exist`.

- [ ] **Step 3: Implement the column**

In `open`, after `create table if not exists ${table}`, run `alter table ${table} add column if not exists "_upstream" text`. It runs on every open, for new and old tables alike. In `write`, the insert becomes:

```sql
insert into ${table} as t (id, data, _upstream)
select r->>'id', r->'data', r->>'upstream' from jsonb_array_elements($1::jsonb) r
on conflict (id) do update set
  data = excluded.data,
  _upstream = coalesce(excluded._upstream, t._upstream),
  _loaded_at = now()
```

Stream sources write through the same `write`, so their rows get null with no change to `stream.ts`.

- [ ] **Step 4: Add the glossary entry**

In `GLOSSARY.md`, next to **Source**, in the same format:

```markdown
**Upstream**:
An RPC endpoint behind eRPC, named by its `id` in `infra/erpc/erpc.yaml`. A raw row's `_upstream` names the one that answered the requests the row came from.
_Avoid_: provider, source
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `cd ingestion && pnpm --filter @ingestion/lib test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ingestion/lib/src/warehouse/index.ts ingestion/lib/src/warehouse/warehouse.test.ts GLOSSARY.md
git commit -m "feat(warehouse): add _upstream to every raw table"
```

### Task 3: Make the Solana client report the upstream

**Files:**
- Modify: `ingestion/lib/package.json`, `ingestion/pnpm-lock.yaml`, `ingestion/lib/src/solana/client.ts`, `ingestion/lib/src/solana/client.test.ts`
- Modify: `ingestion/sources/solana-sol-balances/src/balances.ts`, `ingestion/sources/solana-sol-balances/src/balances.test.ts`

**Interfaces:**
- Consumes: `noteResponse` and `withUpstream` from Task 1.
- Produces: `createSolanaClient(url, options)` keeps its signature. Every reply it gets is noted.

- [ ] **Step 1: Add the dependency**

Run: `cd ingestion && pnpm --filter @ingestion/lib add @solana/rpc-spec-types@^8.6.0`
Expected: `ingestion/lib/package.json` lists it, and the lockfile resolves it to 8.6.0, the version kit uses.

- [ ] **Step 2: Write the failing tests**

In `lib/src/solana/client.test.ts`, with a local server like `failingRpc`:

- `a reply's eRPC upstream reaches withUpstream`: the server answers `getBalance` with header `x-erpc-upstreams: sol-publicnode=primary:success:1ms:won`. Assert `(await withUpstream(() => rpc.getBalance(address).send())).upstream === "sol-publicnode"`.
- `a lamport balance above 2^53 comes back exact`: the server writes the raw text `{"jsonrpc":"2.0","id":0,"result":{"context":{"slot":1},"value":9007199254740993}}`. Assert `value === 9007199254740993n`.

In `solana-sol-balances/src/balances.test.ts`, add the same header to the existing server and assert that every record carries `upstream: "sol-publicnode"`.

- [ ] **Step 3: Run the tests to see them fail**

Run: `cd ingestion && pnpm --filter @ingestion/lib test && pnpm --filter @ingestion/solana-sol-balances test`
Expected: FAIL. Every upstream is null.

- [ ] **Step 4: Replace kit's transport with one that reads headers**

In `createSolanaClient`, replace `createDefaultRpcTransport({ url })` with a `send` of your own. It POSTs `stringifyJsonWithBigInts(payload)` with `content-type: application/json` and the caller's `signal`, calls `noteResponse(url, response)`, and parses the body with `parseJsonWithBigInts`. A response that is not OK throws `new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { headers: response.headers, message: response.statusText, statusCode: response.status })`. Keep the limiter, `withRetry` and `throwUnnamedRpcError` as they are.

- [ ] **Step 5: Put the upstream on `solana-sol-balances` records**

In `fetchBalances`, wrap each group's `.send()` in `withUpstream`, and give every record from that group its `upstream`. This is the only Solana source that builds records by hand. `solana-spl-balances` reads through `settleCalls` and needs no change.

- [ ] **Step 6: Run the tests to see them pass**

Run: `cd ingestion && pnpm --filter @ingestion/lib test && pnpm --filter @ingestion/solana-sol-balances test && pnpm --filter @ingestion/solana-spl-balances test && pnpm typecheck`
Expected: PASS. `retry.test.ts` and the existing `client.test.ts` cases pass unchanged, which proves an HTTP error is still not retried and eRPC's `-32000` still reports its message.

- [ ] **Step 7: Commit**

```bash
git add ingestion/lib/package.json ingestion/pnpm-lock.yaml ingestion/lib/src/solana ingestion/sources/solana-sol-balances/src
git commit -m "feat(solana): report the eRPC upstream of each reply"
```

### Task 4: Send each EVM read alone and report its upstream

**Files:**
- Modify: `ingestion/lib/src/evm/client.ts`, `ingestion/lib/src/evm/env.ts`, `ingestion/lib/src/evm/client.test.ts`
- Modify: `ingestion/sources/evm-erc20-balances/src/balances.ts`, `balances.test.ts`
- Modify: `ingestion/sources/evm-erc20-metadata/src/source.ts`, `source.test.ts`
- Modify: `ingestion/sources/{evm-eth-balances,evm-erc20-balances,evm-erc20-metadata}/src/source.test.ts` (test envs)
- Modify: `.env.example` files under `ingestion/sources/evm-*` that set or mention `RPC_BATCH_SIZE`
- Modify: `orchestration/pipeline/cli/doctor.py`, `orchestration/tests/test_cli_doctor.py`

**Interfaces:**
- Consumes: `noteResponse` and `withUpstream` from Task 1.
- Produces: `createEvmClient(rpcUrl: string, { maxConcurrency?, retryCount? }?)`. `EvmEnv` loses `RPC_BATCH_SIZE`. `fetchBalances` and `fetchMetadata` keep their signatures.

- [ ] **Step 1: Measure how eRPC answers a revert**

With the stack up, run:

```bash
curl -si localhost:4000/main/evm/1 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48","data":"0x12345678"},"latest"]}'
```

USDC has no function with selector `0x12345678`, so the call reverts.
Expected: HTTP 200 with a JSON-RPC `error`. Record its `code` and `message` in this plan's **Facts** table. The revert replies in Step 2's fakes copy them. If eRPC answers with any other HTTP status, stop. viem would then raise `HttpRequestError` for a revert, and a revert could not be told from a failed request. Report that to the user before going on.

- [ ] **Step 2: Write the failing tests**

In `lib/src/evm/client.test.ts`, replace `connect resolves BLOCK_NUMBER at EVM_RPC_URL and batches RPC_BATCH_SIZE calls per request` with:

- `connect sends each read as its own HTTP request, with no Multicall3`: start three `readContract` `balanceOf` calls on three tokens in one tick. Assert the server got three HTTP requests, each a single JSON object with method `eth_call` and `params[0].to` equal to its token.
- `a reply's eRPC upstream reaches withUpstream`: the server sets `x-erpc-upstreams: eth-blastapi=retry:success:1ms:won`. Assert `withUpstream(() => client.getBalance(...))` gives `eth-blastapi`.
- `a retried read takes the upstream of the reply that answered`: the server answers 503 first, then 200 with a header naming `eth-blastapi`. Assert the upstream is `eth-blastapi`.

In `evm-erc20-balances/src/balances.test.ts` and `evm-erc20-metadata/src/source.test.ts`, replace the fake RPC that decodes `aggregate3` with one that answers each lone `eth_call` by its `params[0].to` and its decoded ERC-20 call. Keep every existing case's meaning, with these changes:

- `records null when ... reverts or the token has no code`: the revert reply is the JSON-RPC error from Step 1. A token with no code answers `"0x"`. Both give a record with a null value and no failed call.
- `queues every call for retry when the batch request itself fails` becomes `queues a call for retry when its request fails`, with an HTTP 503 case and a JSON-RPC `-32000` case. Drop the code 3 case, which is now a revert.
- In metadata, `reads each call at its own block, every read of a block in one eth_call` becomes `reads each call at its own block`.
- Add `every record carries the upstream the server names` to both files.

- [ ] **Step 3: Run the tests to see them fail**

Run: `cd ingestion && pnpm --filter @ingestion/lib test && pnpm --filter @ingestion/evm-erc20-balances test && pnpm --filter @ingestion/evm-erc20-metadata test`
Expected: FAIL. The client still batches and merges, and every upstream is null.

- [ ] **Step 4: Change the client**

In `createEvmClient`, drop `batch` from `http()` and from `createPublicClient`, and drop the `batchSize` option. `fetchFn` awaits `limit(() => fetch(input, init))`, calls `noteResponse(rpcUrl, response)` and returns the response. Rewrite the doc comment, which describes both kinds of batching. Remove `RPC_BATCH_SIZE` from `evmEnv`, from `connect` and from the doc comments that name it.

- [ ] **Step 5: Recognise a revert on a lone `eth_call` in both ERC-20 sources**

Change `revertedAtBlock` in `evm-erc20-balances/src/balances.ts` and `evm-erc20-metadata/src/source.ts` so that the Step 1 revert reply counts as a revert and the 503 and `-32000` replies do not. Pick the viem error class from what each path raises for that reply, since `readContract` and `call` wrap errors differently. The tests decide. Keep `ContractFunctionZeroDataError` for an empty reply in `evm-erc20-balances`. Rewrite the comments that say the client merges reads into Multicall3.

- [ ] **Step 6: Remove `RPC_BATCH_SIZE` everywhere**

Drop it from the test envs in the three `source.test.ts` files, from every `.env.example` line that sets it, and from the comments in `evm-eth-balances/.env.example` and `evm-erc20-balances/.env.example` that mention it. In `doctor.py`, remove it from `OPTIONAL_KEYS` and from the comment above. In `test_cli_doctor.py`, remove it from the fixture `.env` and from the tuple of keys that must never show as missing. Then run `grep -rn RPC_BATCH_SIZE ingestion orchestration --exclude-dir=node_modules --exclude-dir=.venv`.
Expected: matches only in local `.env` files, which git ignores and zod drops as unknown keys.

- [ ] **Step 7: Run the tests to see them pass**

Run: `cd ingestion && pnpm typecheck && pnpm -r test`, then `cd orchestration && uv run pytest tests/test_cli_doctor.py -q`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add ingestion/lib/src/evm ingestion/sources orchestration/pipeline/cli/doctor.py orchestration/tests/test_cli_doctor.py
git commit -m "feat(evm): send each read alone and report its eRPC upstream"
```

### Task 5: Run every RPC source through eRPC and check `_upstream`

**Files:** none. This task produces evidence.

**Interfaces:**
- Consumes: everything above, on the stack from Setup.

Every psql command below runs from the repo root after `set -a && . ./.env && set +a`, as `psql "postgresql://$WAREHOUSE_USER:$WAREHOUSE_PASSWORD@$WAREHOUSE_HOST:$WAREHOUSE_PORT/$WAREHOUSE_DB"`, written below as `psql`.

- [ ] **Step 1: Make the local settings use eRPC**

Run `grep -rn -E "EVM_RPC_URL|SOLANA_RPC_URL" ingestion/sources/*/.env ingestion/sources/*/chains/*/.env`. Set every value that does not start with `http://localhost:4000/main/` to the eRPC URL for its chain from **Global Constraints**. These files are local and not committed.
Expected: every value starts with `http://localhost:4000/main/`.

- [ ] **Step 2: Run each RPC source once on the branch**

```bash
cd ingestion/sources/solana-sol-balances && pnpm ingest
cd ../solana-spl-balances && pnpm ingest
cd ../evm-eth-balances && CHAIN=ethereum pnpm ingest
cd ../evm-erc20-balances && CHAIN=ethereum pnpm ingest
for c in ethereum arbitrum base; do (cd ../evm-erc20-metadata && CHAIN=$c pnpm ingest); done
for c in arbitrum base; do (cd ../evm-address-code && CHAIN=$c pnpm ingest); done
```

Expected: every run exits 0 and logs no failed calls.

- [ ] **Step 3: Check that each table names real upstreams**

For each of `solana_sol_balances`, `solana_spl_balances`, `ethereum_eth_balances`, `ethereum_erc20_balances`, `ethereum_erc20_metadata`, `arbitrum_erc20_metadata`, `base_erc20_metadata`, `arbitrum_address_code` and `base_address_code`, run `psql -c "select _upstream, count(*) from raw.<table> where _loaded_at > now() - interval '15 minutes' group by 1 order by 2 desc"`.
Expected: every value is an upstream `id` that `infra/erpc/erpc.yaml` lists for that network, such as `sol-publicnode` for Solana and `eth-blastapi` for Ethereum. A metadata row may be null when its three reads went to different upstreams. Any other null means eRPC answered from its cache. Check that with `curl -si` on the same request before treating it as a bug.

- [ ] **Step 4: Check that a cached rerun keeps the upstream**

Pin `BLOCK_NUMBER` to the block Step 2 loaded for `evm-erc20-balances` (`select max((data->>'block_number')::bigint) from raw.ethereum_erc20_balances`). Save `select id, _upstream from raw.ethereum_erc20_balances where (data->>'block_number')::bigint = <block>`, run `BLOCK_NUMBER=<block> CHAIN=ethereum pnpm ingest` again, and run the select again.
Expected: the same ids with the same `_upstream`, and a later `_loaded_at`. eRPC's Postgres cache answered, and `coalesce` kept the first run's upstream.

- [ ] **Step 5: Check that a Portal table got the column and left it empty**

Run: `psql -c "select count(*) filter (where _upstream is not null) from raw.ethereum_erc20_transfers"` after the next `evm-erc20-transfers` run, or now if the table exists.
Expected: `0`, with no error.

- [ ] **Step 6: Measure what sending each read alone costs**

This step runs last, because trunk writes rows with a null `_upstream` into the same tables. Both sides must go through eRPC, so first check that `chains/ethereum/.env` in the main checkout and in the worktree both set `EVM_RPC_URL=http://localhost:4000/main/evm/1`. For `evm-erc20-balances` and `evm-erc20-metadata` on Ethereum, with `BLOCK_NUMBER=latest` so no run reuses eRPC's cache, run trunk, branch, trunk, branch, alternating. Before and after each run, read `sum(erpc_upstream_request_total)` with `curl -s localhost:9090/api/v1/query --data-urlencode 'query=sum(erpc_upstream_request_total)'`, waiting one scrape interval after the run. Read the run time with `psql -c "select finished_at - started_at from ops.ingestion_runs order by started_at desc limit 1"`.
Expected: the branch sends about one upstream request per read, 9 for balances and 12 for metadata, plus the block lookup and eRPC's own retries. Trunk sends about one per 5 reads. Each run on the branch takes no more than 2 seconds longer than trunk's. A result outside these limits stops the task until its cause is explained.
