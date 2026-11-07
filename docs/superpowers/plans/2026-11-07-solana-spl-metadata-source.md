# Solana SPL Metadata Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `solana-spl-metadata`, a call source that reads each listed SPL mint's decimals, name and symbol into `raw.solana_spl_metadata`, and add Solana to `analytics.tokens`, so SPL balances can be shown in whole tokens.

**Architecture:** `bj new-source` copies `solana-spl-balances`, so the new package has the same layout: one Source, `addresses.json` at the package root, and reads at the latest finalized slot. Each mint costs one `getMultipleAccounts` request for two accounts at one slot. The first is the mint, which `jsonParsed` decodes into decimals and any Token-2022 `tokenMetadata` extension. The second is the mint's Metaplex metadata account, which comes back as base64 and is decoded with `@solana/kit` codecs. The source records both name and symbol pairs and does not choose between them: `int_solana_spl_metadata` applies that rule, because `layers.md` keeps rules out of ingestion.

**Tech Stack:** TypeScript on Node 24, the pnpm workspace in `ingestion/`, `@solana/kit` ^8.6.0 (already a dependency), zod 4, `node:test` run by tsx; dbt on Postgres; Dagster tests in `orchestration/` with pytest.

**Spec:** No design doc exists. The plan argues from:
- `/Users/ianguimaraes/Projects/am/take-home/description.md`: "Solana: Native SOL and SPL tokens", and the output column `balance_tokens` "(human-readable token units, adjusted for decimals)".
- `docs/plans/README.md`: names the package `solana-spl-metadata` and says the CSV's mints go into its `addresses.json`.
- The reference: `ingestion/sources/evm-erc20-metadata/` and its dbt path into `analytics.tokens`.
- House rules: `.claude/skills/blockjuice/workflows/state-source.md` and `.claude/skills/blockjuice/references/layers.md`.

## Setup

- [ ] Create the worktree with superpowers:using-git-worktrees: branch `feat/solana-spl-metadata` from `main`.
- [ ] From the worktree root, run `uv run --project orchestration bj install`. It copies the `.env` files, installs the pnpm packages and runs `dbt parse`.
- [ ] Start the stack: `docker compose up -d`. The live run in Task 2 needs the warehouse and eRPC. Check that eRPC serves Solana: `curl -s localhost:4000/main/solana -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getSlot","params":[{"commitment":"finalized"}]}'` should print a `result` with a slot. If it does not, fix eRPC (`infra/erpc/erpc.yaml`, `docker compose logs erpc`); never point the package at a public Solana RPC instead.
- [ ] Record the baseline: `cd ingestion && pnpm typecheck && pnpm --filter @ingestion/solana-spl-balances test`, then `cd orchestration && uv run pytest tests/test_sources_json.py tests/test_definitions.py -q`. Note any failure that predates this work.
- [ ] This plan is not committed. Read it from the main checkout at `docs/superpowers/plans/2026-11-07-solana-spl-metadata-source.md`.

## Facts checked on mainnet

Read while planning on 2026-11-07 (slot about 466,542,000) with `getMultipleAccounts(..., { commitment: "finalized", encoding: "jsonParsed" })` through `@solana/kit` 8.6.0, from the Solana Foundation endpoint that eRPC also proxies. The test fixtures copy these shapes; Task 2 checks them again through eRPC.

| Account | What came back |
|---|---|
| USDC mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | `owner` `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`; `data.program` `"spl-token"`; `data.parsed.type` `"mint"`; `data.parsed.info.decimals` `6`; no `extensions` key |
| USDC Metaplex account `5x38Kp4hvdomTCnCrAny4UtMUt5rQBdB6px2K1Ui45Wq` | `owner` `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s`; `data` `["<base64>", "base64"]`; key `4`, name `"USD Coin"`, symbol `"USDC"` |
| USDT mint `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` | like USDC; Metaplex account `8c3zk1t1qt3RU43ckuvPkCS7HLbjJqq3J3Me8ov4aHrp`, name `"USDT"`, symbol `"USDT"` |
| PYUSD mint `2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo` | `owner` `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`; `data.program` `"spl-token-2022"`; decimals `6`; `info.extensions` holds `{ extension: "metadataPointer", state: { authority, metadataAddress: <the mint> } }` and `{ extension: "tokenMetadata", state: { additionalMetadata: [], mint, name: "PayPal USD", symbol: "PYUSD", updateAuthority, uri } }`. Its Metaplex account is `null` |
| Wallet `9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM` | `owner` `11111111111111111111111111111111`; `data` `["", "base64"]` |

Kit hands back `context.slot` and `space` as bigints and `decimals` as a number.

## Global Constraints

- Package `ingestion/sources/solana-spl-metadata`, npm name `@ingestion/solana-spl-metadata`. `src/source.ts` exports one Source, `solanaSplMetadata`, with `name: "solana"` and `table: "spl_metadata"`. It loads `raw.solana_spl_metadata`, and its Dagster asset key is `["solana", "spl_metadata"]`.
- `addresses.json` sits at the package root and holds `{ "mints": [...] }`, the key `solana-spl-balances` uses.
- No change to `ingestion/lib`, `runSource` or the Source contract (`layers.md`). The Metaplex code stays in the package.
- No new dependency. Decode with `@solana/kit` codecs; do not add `@metaplex-foundation/*` or `@solana-program/*`.
- Every read uses `{ commitment: "finalized", encoding: "jsonParsed" }`.
- Every Solana read goes through eRPC: `SOLANA_RPC_URL=http://localhost:4000/main/solana`, as the copied `.env.example` sets it. Keep that value in `.env` too. eRPC holds the upstreams and their rate limits (`infra/erpc/erpc.yaml`); `getMultipleAccounts` falls under the `sol-foundation` budget of 6 calls a second.
- Metaplex: program `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s`; the metadata address is the PDA of seeds `["metadata", <program address bytes>, <mint address bytes>]`; a metadata account starts with key `4` (u8), update authority (32 bytes), mint (32 bytes), name (u32 length, then UTF-8), symbol (u32 length, then UTF-8).
- Record `data` keys are snake_case, in this order: `slot`, `mint`, `owner_program`, `decimals`, `token_2022_name`, `token_2022_symbol`, `metaplex_name`, `metaplex_symbol`.
- A record's `id` is `${slot}:${mint}`. Its call id is the mint alone, because a Solana RPC cannot read a past slot. `solana-spl-balances` does the same.
- Drop every zero byte from each name and symbol, and record an empty result as null. Postgres rejects `\u0000` in jsonb, which would fail the whole batch (`evm-erc20-metadata` does the same).
- Mints are case-sensitive base58. No layer lowercases them.
- A fact about the chain becomes a record; a failed request becomes a failed call. Facts: no mint account, an account that is not a mint, a Metaplex address that the Metaplex program does not own. Failures: an HTTP error, a JSON-RPC error, Metaplex data that does not decode or does not start with key 4.
- `createSolanaClient(env.SOLANA_RPC_URL, { maxConcurrency: 2 })`. The `tokens` and `balances` jobs both run at 06:00 and share one RPC with `solana-spl-balances`.
- `ingestion/tsconfig.json` is strict, with `noUncheckedIndexedAccess` and `erasableSyntaxOnly`. Imports inside a package use `#src/<file>.ts`.
- Tests use `node:test`, `node:assert/strict`, a local HTTP JSON-RPC server and `retryCount: 0`, as `solana-spl-balances/src/balances.test.ts` does.
- dbt and Dagster commands run from the repo root after `set -a && . ./.env && set +a`. dbt runs as `uv run --project orchestration dbt <command> --project-dir transformation --profiles-dir transformation`, written below as `dbt <command>`.
- Prose in doc comments, YAML descriptions and docs: short words, active voice, no stock phrases.

## Review Focus

1. A free RPC answers HTTP 429. The call should wait as a dead letter, never land as a row of nulls, which the mart would serve as "no decimals". Test: Task 1, "queues each call the RPC refuses or errors on, and keeps the others".
2. A wallet address in `mints`, which the CSV writer could put there. The run should record it with `owner_program` set to the System Program and null decimals, with no failed call. Test: Task 1, "records nulls when the mint has no account or is a wallet".
3. Lamports sent to a mint's Metaplex address before any metadata exists, which leaves a System-owned account with no data there. The source should record null Metaplex names, not fail the call on every run until it is parked. Test: Task 1, "records null Metaplex names when its address holds only lamports".
4. A mint listed twice, or listed and also waiting as a dead letter. It should cost one request and give one row. Test: Task 1, "asks for each mint and its Metaplex account once".
5. A Token-2022 mint with metadata in both places. `analytics.tokens` should show the extension's name. Tests: Task 1, "keeps both names when a mint has both", and Task 3's dbt unit test.

## Out of Scope

- Other mint and metadata fields: `uri`, `additionalMetadata`, supply, authorities.
- Following a `metadataPointer` that points at a third account. Such a mint gets null names unless it also has Metaplex metadata.
- Reading only the mints the CSV asks for (plans 07 and 08).
- Renaming `block_number` in `analytics.tokens`. Solana rows put their slot there.
- Computing `balance_tokens` (plan 06).

## File Structure

`bj new-source solana spl_metadata --like solana-spl-balances` creates or changes the first group; later tasks edit them.

- `ingestion/sources/solana-spl-metadata/`: copied package. Keep `package.json` (renamed by the scaffold) and `.env.example`. Rewrite `addresses.json`, `src/index.ts`, `src/source.ts` and `src/source.test.ts`. Delete `src/balances.ts` and `src/balances.test.ts`.
- Create `ingestion/sources/solana-spl-metadata/src/metadata.ts`: the call schema, the Metaplex address and decoder, and `fetchMetadata`.
- Create `ingestion/sources/solana-spl-metadata/src/metadata.test.ts`.
- `ingestion/sources.json` and `ingestion/pnpm-lock.yaml`: changed by the scaffold.
- `transformation/models/staging/solana/_solana__sources.yml`: the scaffold adds `spl_metadata`.
- `transformation/models/staging/solana/stg_solana__spl_metadata.sql`: the scaffold's stub; Task 2 shapes it.
- Modify `transformation/models/staging/solana/_solana__models.yml` (Task 2).
- Create `transformation/models/intermediate/tokens/int_solana_spl_metadata.sql` (Task 3).
- Modify `transformation/models/intermediate/tokens/_int_tokens__models.yml`, `transformation/models/marts/tokens/tokens.sql`, `transformation/models/marts/tokens/_tokens__models.yml` (Task 3).
- Modify `orchestration/tests/test_definitions.py`, `docs/architecture.md`, `README.md` (Task 3).

---

### Task 1: Read each mint's decimals, names and symbols

**Files:**
- Scaffold: everything `bj new-source` writes (see File Structure)
- Create: `ingestion/sources/solana-spl-metadata/src/metadata.ts`
- Modify: `ingestion/sources/solana-spl-metadata/src/source.ts`, `src/index.ts`, `addresses.json`
- Delete: `ingestion/sources/solana-spl-metadata/src/balances.ts`, `src/balances.test.ts`
- Test: `ingestion/sources/solana-spl-metadata/src/metadata.test.ts`, `src/source.test.ts`

**Interfaces:**
- Consumes: `settleCalls`, `readJson`, `type Batch`, `type Source` from `@ingestion/lib`; `createSolanaClient`, `solanaAddress`, `solanaEnv`, `validateSolanaAddressList`, `type SolanaClient`, `type SolanaEnv` from `@ingestion/lib/solana`.
- Produces, in `src/metadata.ts`:

```ts
export const METAPLEX_PROGRAM: Address; // "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
export const metadataCallSchema: z.ZodObject<...>; // z.object({ kind: z.literal("spl_metadata"), mint: solanaAddress })
export type MetadataCall = z.infer<typeof metadataCallSchema>; // { kind: "spl_metadata"; mint: Address }
export const metadataCalls: (mints: readonly Address[]) => MetadataCall[];
export function fetchMetadata(rpc: SolanaClient, calls: readonly MetadataCall[]): Promise<Batch<MetadataCall>>;
```

  Each record's `data`:

```ts
{
  slot: bigint;                      // context.slot of the reply
  mint: Address;
  owner_program: Address | null;     // the mint account's owner; null when it has no account
  decimals: number | null;           // null unless data.parsed.type is "mint"
  token_2022_name: string | null;    // from the "tokenMetadata" extension, if any
  token_2022_symbol: string | null;
  metaplex_name: string | null;      // null when the Metaplex account is missing or not owned by METAPLEX_PROGRAM
  metaplex_symbol: string | null;
}
```

- Produces, in `src/source.ts`: `export const solanaSplMetadata: Source<SolanaEnv, MetadataCall>`.

- [ ] **Step 1: Scaffold the package**

Run from the repo root: `uv run --project orchestration bj new-source solana spl_metadata --like solana-spl-balances`
Expected: it prints `created ingestion/sources/solana-spl-metadata/ (a copy of solana-spl-balances)`, `changed transformation/models/staging/solana/_solana__sources.yml`, `created transformation/models/staging/solana/stg_solana__spl_metadata.sql` and `changed ingestion/sources.json`, then exits 0. `ingestion/sources.json` now lists `{ "name": "solana", "table": "spl_metadata", "package": "solana-spl-metadata" }`.

Then, in the new package: delete `src/balances.ts` and `src/balances.test.ts`, run `cp .env.example .env`, and set `addresses.json` to:

```json
{
  "mints": [
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo"
  ]
}
```

- [ ] **Step 2: Write the failing tests** in `src/metadata.test.ts`

```ts
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import {
  addEncoderSizePrefix, getAddressDecoder, getAddressEncoder, getBase64Decoder, getStructEncoder,
  getU32Encoder, getU8Encoder, getUtf8Encoder, type Address,
} from "@solana/kit";
import { createSolanaClient } from "@ingestion/lib/solana";
import { METAPLEX_PROGRAM, fetchMetadata, metadataCalls } from "#src/metadata.ts";

const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;
const SYSTEM = "11111111111111111111111111111111" as Address;

const addressOf = (n: number): Address => {
  const bytes = new Uint8Array(32);
  new DataView(bytes.buffer).setUint32(0, n + 1);
  return getAddressDecoder().decode(bytes);
};
const [classic, token2022, wallet, missing, broken, refused, erroring] = [0, 1, 2, 3, 4, 5, 6].map(addressOf) as [
  Address, Address, Address, Address, Address, Address, Address,
];

/** A jsonParsed account as the RPC sends it. */
const account = (owner: Address, data: unknown) => ({ lamports: 1461600, owner, executable: false, rentEpoch: 0, space: 82, data });

const mintAccount = (decimals: number, extensions?: unknown[]) =>
  account(extensions ? TOKEN_2022 : TOKEN, {
    program: extensions ? "spl-token-2022" : "spl-token",
    space: 82,
    parsed: {
      type: "mint",
      info: { decimals, freezeAuthority: null, isInitialized: true, mintAuthority: null, supply: "1000", ...(extensions && { extensions }) },
    },
  });

const tokenMetadata = (mint: Address, name: string, symbol: string) => ({
  extension: "tokenMetadata",
  state: { additionalMetadata: [], mint, name, symbol, updateAuthority: null, uri: "" },
});

const metaplexEncoder = getStructEncoder([
  ["key", getU8Encoder()],
  ["updateAuthority", getAddressEncoder()],
  ["mint", getAddressEncoder()],
  ["name", addEncoderSizePrefix(getUtf8Encoder(), getU32Encoder())],
  ["symbol", addEncoderSizePrefix(getUtf8Encoder(), getU32Encoder())],
  ["uri", addEncoderSizePrefix(getUtf8Encoder(), getU32Encoder())],
]);

const metaplex = (mint: Address, name: string, symbol: string, key = 4) =>
  account(METAPLEX_PROGRAM, [
    getBase64Decoder().decode(metaplexEncoder.encode({ key, updateAuthority: mint, mint, name, symbol, uri: "" })),
    "base64",
  ]);

const lamportsOnly = account(SYSTEM, ["", "base64"]);

/** What the RPC holds for one mint, keyed by the mint: its accounts, an HTTP status, or a JSON-RPC error. A mint left out has no accounts. */
type Entry = { mint?: object; metaplex?: object } | { status: number } | { error: { code: number; message: string } };
type Request = { id: number; method: string; params: [Address[], Record<string, unknown>] };

/** A JSON-RPC endpoint that answers getMultipleAccounts at slot 7 from `ledger`. Returns its URL and every request it got. */
async function fakeRpc(t: TestContext, ledger: Record<string, Entry>) {
  const requests: Request[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const request: Request = JSON.parse(body);
    requests.push(request);
    const entry = ledger[request.params[0][0]!] ?? {};
    if ("status" in entry) {
      res.statusCode = entry.status;
      res.end();
      return;
    }
    const reply = "error" in entry
      ? { error: entry.error }
      : { result: { context: { slot: 7 }, value: [entry.mint ?? null, entry.metaplex ?? null] } };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...reply }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

// No transport retries, so a failed request fails at once rather than after the backoff.
const rpcAt = (url: string) => createSolanaClient(url, { retryCount: 0 });

const NO_NAMES = { token_2022_name: null, token_2022_symbol: null, metaplex_name: null, metaplex_symbol: null };
```

Then these tests, each with exactly these assertions:

```ts
test("reads decimals from the mint, and name and symbol from its Metaplex account", async (t) => {
  const { url } = await fakeRpc(t, { [classic]: { mint: mintAccount(6), metaplex: metaplex(classic, "USD Coin", "USDC") } });
  const batch = await fetchMetadata(rpcAt(url), metadataCalls([classic]));
  assert.deepEqual(batch, {
    records: [{
      id: `7:${classic}`,
      callId: classic,
      data: { slot: 7n, mint: classic, owner_program: TOKEN, decimals: 6, ...NO_NAMES, metaplex_name: "USD Coin", metaplex_symbol: "USDC" },
    }],
    failed: [],
  });
});

test("reads name and symbol from a Token-2022 mint's metadata extension", async (t) => {
  const pointer = { extension: "metadataPointer", state: { authority: null, metadataAddress: token2022 } };
  const { url } = await fakeRpc(t, { [token2022]: { mint: mintAccount(6, [pointer, tokenMetadata(token2022, "PayPal USD", "PYUSD")]) } });
  const batch = await fetchMetadata(rpcAt(url), metadataCalls([token2022]));
  assert.deepEqual(batch.records.map(({ data }) => data), [
    { slot: 7n, mint: token2022, owner_program: TOKEN_2022, decimals: 6, ...NO_NAMES, token_2022_name: "PayPal USD", token_2022_symbol: "PYUSD" },
  ]);
});

test("keeps both names when a mint has both, for dbt to choose", async (t) => {
  const { url } = await fakeRpc(t, {
    [token2022]: { mint: mintAccount(6, [tokenMetadata(token2022, "PayPal USD", "PYUSD")]), metaplex: metaplex(token2022, "Old Name", "OLD") },
  });
  const batch = await fetchMetadata(rpcAt(url), metadataCalls([token2022]));
  assert.deepEqual(
    batch.records.map(({ data }) => [data.token_2022_name, data.token_2022_symbol, data.metaplex_name, data.metaplex_symbol]),
    [["PayPal USD", "PYUSD", "Old Name", "OLD"]],
  );
});

test("drops zero bytes, and records null for a name that is only zero bytes", async (t) => {
  const { url } = await fakeRpc(t, {
    [classic]: { mint: mintAccount(6), metaplex: metaplex(classic, "\u0000".repeat(32), "US\u0000DC\u0000") },
    [token2022]: { mint: mintAccount(6, [tokenMetadata(token2022, "Pay\u0000Pal", "\u0000")]) },
  });
  const batch = await fetchMetadata(rpcAt(url), metadataCalls([classic, token2022]));
  assert.deepEqual(
    batch.records.map(({ data }) => [data.token_2022_name, data.token_2022_symbol, data.metaplex_name, data.metaplex_symbol]),
    [[null, null, null, "USDC"], ["PayPal", null, null, null]],
    "no zero byte reaches the jsonb column, and an empty name is null",
  );
});

test("records nulls when the mint has no account or is a wallet, without failing the call", async (t) => {
  const { url } = await fakeRpc(t, { [wallet]: { mint: lamportsOnly } });
  const batch = await fetchMetadata(rpcAt(url), metadataCalls([missing, wallet]));
  assert.deepEqual(batch.failed, [], "an address that is not a mint is a fact, not a failed call");
  assert.deepEqual(batch.records.map(({ data }) => data), [
    { slot: 7n, mint: missing, owner_program: null, decimals: null, ...NO_NAMES },
    { slot: 7n, mint: wallet, owner_program: SYSTEM, decimals: null, ...NO_NAMES },
  ]);
});

test("records null Metaplex names when its address holds only lamports", async (t) => {
  const { url } = await fakeRpc(t, { [classic]: { mint: mintAccount(6), metaplex: lamportsOnly } });
  const batch = await fetchMetadata(rpcAt(url), metadataCalls([classic]));
  assert.deepEqual(batch.failed, []);
  assert.deepEqual(batch.records.map(({ data }) => [data.decimals, data.metaplex_name]), [[6, null]]);
});

test("queues a Metaplex account it cannot decode for retry", async (t) => {
  const { url } = await fakeRpc(t, {
    [classic]: { mint: mintAccount(6), metaplex: metaplex(classic, "USD Coin", "USDC", 7) },
    [broken]: { mint: mintAccount(6), metaplex: account(METAPLEX_PROGRAM, ["BAEC", "base64"]) },
  });
  const batch = await fetchMetadata(rpcAt(url), metadataCalls([classic, broken]));
  assert.deepEqual(batch.records, []);
  assert.deepEqual(batch.failed.map(({ id }) => id), [classic, broken], "a wrong key and truncated data both wait for the next run");
});

test("queues each call the RPC refuses or errors on, and keeps the others", async (t) => {
  const { url } = await fakeRpc(t, {
    [classic]: { mint: mintAccount(6) },
    [refused]: { status: 429 },
    [erroring]: { error: { code: -32602, message: "Invalid param: could not find account" } },
  });
  const batch = await fetchMetadata(rpcAt(url), metadataCalls([classic, refused, erroring]));
  assert.deepEqual(batch.records.map(({ id }) => id), [`7:${classic}`]);
  assert.deepEqual(
    batch.failed.map(({ id, call }) => ({ id, call })),
    [
      { id: refused, call: { kind: "spl_metadata", mint: refused } },
      { id: erroring, call: { kind: "spl_metadata", mint: erroring } },
    ],
    "an RPC failure is never recorded as a mint without metadata",
  );
  assert.match(batch.failed[1]!.error, /could not find account/);
});

test("asks for each mint and its Metaplex account once, in one finalized jsonParsed request", async (t) => {
  const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address;
  const { url, requests } = await fakeRpc(t, {});
  // A mint listed twice, and again as a retried call, is read once.
  await fetchMetadata(rpcAt(url), [...metadataCalls([usdc, usdc]), ...metadataCalls([usdc])]);
  assert.deepEqual(
    requests.map(({ method, params }) => [method, params]),
    [["getMultipleAccounts", [[usdc, "5x38Kp4hvdomTCnCrAny4UtMUt5rQBdB6px2K1Ui45Wq"], { commitment: "finalized", encoding: "jsonParsed" }]]],
    "the Metaplex address is the one mainnet holds USDC's metadata at",
  );
});
```

Rewrite `src/source.test.ts` from the copy. Keep its `addressesHold` helper, with the temp folder prefix `solana-spl-metadata-`, and its `env`. `firstBatch` calls `solanaSplMetadata.extract(env, [])`. Tests:

```ts
test("a bad mint in addresses.json fails the run, not the import", async (t) => {
  await addressesHold(t, JSON.stringify({ mints: ["not-an-address"] }));
  await assert.rejects(firstBatch(), { message: "Invalid Solana addresses:\n  not-an-address" });
});

test("malformed addresses.json fails the run, not the import", async (t) => {
  await addressesHold(t, '{ "mints": [], }');
  await assert.rejects(firstBatch(), /addresses\.json is not valid JSON/);
});

test("loads raw.solana_spl_metadata", () => {
  assert.equal(solanaSplMetadata.name, "solana");
  assert.equal(solanaSplMetadata.table, "spl_metadata");
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `cd ingestion/sources/solana-spl-metadata && pnpm test`
Expected: FAIL. `metadata.test.ts` cannot import `#src/metadata.ts`, and `source.test.ts` finds no `solanaSplMetadata` export.

- [ ] **Step 4: Implement `src/metadata.ts`, then rewire `src/source.ts` and `src/index.ts`**

`fetchMetadata` is `settleCalls(calls, (call) => call.mint, read, (call, data) => \`${data.slot}:${call.mint}\`)`. Each `read` derives the Metaplex address with `getProgramDerivedAddress({ programAddress: METAPLEX_PROGRAM, seeds: ["metadata", encode(METAPLEX_PROGRAM), encode(mint)] })`, where `encode` is `getAddressEncoder().encode`. Keep that helper private. It then sends one `rpc.getMultipleAccounts([mint, metaplexAddress], { commitment: "finalized", encoding: "jsonParsed" })`. Read the two accounts like this:

- Mint account (`value[0]`): `owner_program` is its `owner`. If its `data` is an array, it is base64 fallback and holds no mint. Otherwise, when `data.parsed.type === "mint"`, parse `data.parsed.info` with a local zod schema: `{ decimals: number, extensions?: { extension: string, state: unknown }[] }`, with a `tokenMetadata` state of `{ name: string, symbol: string }`. A mint whose `info` does not match throws, so the call is retried. The RPC is a system boundary, so the check belongs here.
- Metaplex account (`value[1]`): null names when it is null or its `owner` is not `METAPLEX_PROGRAM`. Otherwise turn `data[0]` into bytes with `getBase64Encoder().encode(...)` and decode it with a `getStructDecoder` over key, update authority, mint, name and symbol. Use `addDecoderSizePrefix(getUtf8Decoder(), getU32Decoder())` for the strings, and ignore the bytes after the symbol. Throw when the key is not `4`. A decode of too few bytes throws on its own.
- Every name and symbol goes through `text(value: string): string | null`, which drops `\u0000` and returns null for an empty result.

`solanaSplMetadata` copies `solanaSplBalances`'s `extract`. Inside the run, it reads `addresses.json` with `readJson`, validates `addresses.mints` with `validateSolanaAddressList`, and creates the client with `{ maxConcurrency: 2 }`. It then yields `await fetchMetadata(rpc, [...metadataCalls(mints), ...retry])`. `src/source.ts` must export only this one Source, because the sources.json generator requires exactly one. `src/index.ts` is `await runSource(solanaSplMetadata);`.

- [ ] **Step 5: Run the tests, the typecheck and the generator**

Run: `cd ingestion/sources/solana-spl-metadata && pnpm test`
Expected: PASS, 12 tests, 0 failures.

Run: `cd ingestion && pnpm typecheck && pnpm --silent generate-sources && git diff -- sources.json`
Expected: `tsc` prints nothing. The diff against `main` adds one entry, `{ "name": "solana", "table": "spl_metadata", "package": "solana-spl-metadata" }`, and changes nothing else.

Until Task 3 wires the mart, `test_every_asset_and_check_runs_in_a_scheduled_pipeline` in `orchestration/` fails, because no scheduled job selects `solana/spl_metadata`. That failure is expected here; Task 3 clears it.

- [ ] **Step 6: Commit**

```bash
git add ingestion/sources/solana-spl-metadata ingestion/sources.json ingestion/pnpm-lock.yaml \
  transformation/models/staging/solana/_solana__sources.yml transformation/models/staging/solana/stg_solana__spl_metadata.sql
git commit -m "feat(ingestion): add solana-spl-metadata source"
```

`git add` skips `.env`, which `.gitignore` lists; check that `git status` does not show it as staged.

---

### Task 2: Load real mints and shape the staging model

**Files:**
- Modify: `transformation/models/staging/solana/stg_solana__spl_metadata.sql`
- Modify: `transformation/models/staging/solana/_solana__models.yml`

**Interfaces:**
- Consumes: `raw.solana_spl_metadata`, as Task 1's records fill it.
- Produces: the view `stg_solana__spl_metadata` with columns `id` text, `slot` bigint, `mint` text, `owner_program` text, `decimals` integer, `token_2022_name`, `token_2022_symbol`, `metaplex_name`, `metaplex_symbol` (text), `_loaded_at` timestamptz.

- [ ] **Step 1: Run the source once against the chain, through eRPC**

Run: `cd ingestion/sources/solana-spl-metadata && grep SOLANA_RPC_URL .env && pnpm ingest`
Expected: `.env` shows `SOLANA_RPC_URL=http://localhost:4000/main/solana`; the run exits 0 and logs no failed calls.

Then check, from the repo root:

```bash
set -a && . ./.env && set +a
psql "postgresql://$WAREHOUSE_USER:$WAREHOUSE_PASSWORD@$WAREHOUSE_HOST:$WAREHOUSE_PORT/$WAREHOUSE_DB" -c \
  "select data->>'mint' mint, data->>'decimals' decimals, data->>'token_2022_name' t22, data->>'metaplex_name' mpl from raw.solana_spl_metadata order by 1"
psql "postgresql://$WAREHOUSE_USER:$WAREHOUSE_PASSWORD@$WAREHOUSE_HOST:$WAREHOUSE_PORT/$WAREHOUSE_DB" -c \
  "select count(*) from raw._dead_letters where source_table = 'solana_spl_metadata'"
```

Expected: three rows. `2b1k…GXo` has decimals 6, t22 `PayPal USD`, mpl empty. `EPjF…Dt1v` has decimals 6, t22 empty, mpl `USD Coin`. `Es9v…NYB` has decimals 6, t22 empty, mpl `USDT`. Dead letters count is `0`. These values are the proof that the Metaplex address and the decoder match the chain. If they differ, fix Task 1 first.

- [ ] **Step 2: Shape `stg_solana__spl_metadata.sql`**

Replace the scaffold's stub. The first line is a comment: `-- One mint in solana-spl-metadata's addresses.json, read at one finalized slot; null where the chain has no value.` Then select `id`, `(data ->> 'slot')::bigint as slot`, `data ->> 'mint' as mint` (not lowercased), `data ->> 'owner_program' as owner_program`, `(data ->> 'decimals')::integer as decimals`, the four name and symbol fields as text, and `_loaded_at`, all from `{{ source('solana', 'spl_metadata') }}`.

- [ ] **Step 3: Describe and test it in `_solana__models.yml`**

Add `stg_solana__spl_metadata` with a description: "The decimals, names and symbols of each mint in solana-spl-metadata's addresses.json, one row per mint and slot read. Each name and symbol is kept as the chain stores it, without zero bytes." Column tests: `id` `[unique, not_null]`; `slot`, `mint` `[not_null]`. Describe `decimals` as "Null when the address is not a mint, such as a wallet." Describe `token_2022_name` as "From the mint's Token-2022 metadata extension." Describe `metaplex_name` as "From the mint's Metaplex metadata account."

- [ ] **Step 4: Build it**

Run: `dbt build --select source:solana.spl_metadata stg_solana__spl_metadata`
Expected: `Completed successfully`, ERROR=0. dbt builds the view and passes the source's and the model's tests.

- [ ] **Step 5: Commit**

```bash
git add transformation/models/staging/solana/stg_solana__spl_metadata.sql transformation/models/staging/solana/_solana__models.yml
git commit -m "feat(transformation): stage solana spl metadata"
```

---

### Task 3: Add Solana to `analytics.tokens`

**Files:**
- Create: `transformation/models/intermediate/tokens/int_solana_spl_metadata.sql`
- Modify: `transformation/models/intermediate/tokens/_int_tokens__models.yml`
- Modify: `transformation/models/marts/tokens/tokens.sql`, `transformation/models/marts/tokens/_tokens__models.yml`
- Modify: `docs/architecture.md`, `README.md`
- Test: `orchestration/tests/test_definitions.py`, and the dbt unit test in `_int_tokens__models.yml`

**Interfaces:**
- Consumes: `stg_solana__spl_metadata` (Task 2).
- Produces: `int_solana_spl_metadata` with the columns every `int_*_erc20_metadata` model has: `id`, `chain`, `token`, `name`, `symbol`, `decimals`, `block_number`, `_loaded_at`. `analytics.tokens` gains `chain = 'solana'` rows.

- [ ] **Step 1: Write the failing Dagster test** in `orchestration/tests/test_definitions.py`, next to `test_erc20_transfers_reads_each_chain_through_its_own_model`

```python
def test_tokens_reads_each_chain_through_its_own_model():
    graph = defs.resolve_asset_graph()
    assert graph.get(dg.AssetKey("tokens")).parent_keys == {
        dg.AssetKey("int_ethereum_erc20_metadata"),
        dg.AssetKey("int_arbitrum_erc20_metadata"),
        dg.AssetKey("int_base_erc20_metadata"),
        dg.AssetKey("int_solana_spl_metadata"),
    }
    assert graph.get(dg.AssetKey("int_solana_spl_metadata")).parent_keys == {
        dg.AssetKey("stg_solana__spl_metadata"),
    }
```

- [ ] **Step 2: Write the failing dbt unit test** in `_int_tokens__models.yml`

Add the model entry `int_solana_spl_metadata`, with description "Solana mint metadata readings in the shape the tokens mart reads." and `id` `[unique, not_null]`, like the others. Then add:

```yaml
unit_tests:
  - name: a_token_2022_name_wins_over_metaplex
    description: The Token-2022 extension's name and symbol win; Metaplex fills the gaps; the mint keeps its case; the slot is the block.
    model: int_solana_spl_metadata
    given:
      - input: ref('stg_solana__spl_metadata')
        rows:
          - {id: "7:2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", slot: 7, mint: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", decimals: 6, token_2022_name: "PayPal USD", token_2022_symbol: "PYUSD", metaplex_name: "Old Name", metaplex_symbol: "OLD"}
          - {id: "7:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", slot: 7, mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6, token_2022_name: null, token_2022_symbol: null, metaplex_name: "USD Coin", metaplex_symbol: "USDC"}
          - {id: "7:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", slot: 7, mint: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", decimals: null, token_2022_name: null, token_2022_symbol: null, metaplex_name: null, metaplex_symbol: null}
    expect:
      rows:
        - {id: "7:2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", chain: solana, token: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", name: "PayPal USD", symbol: "PYUSD", decimals: 6, block_number: 7}
        - {id: "7:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", chain: solana, token: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", name: "USD Coin", symbol: "USDC", decimals: 6, block_number: 7}
        - {id: "7:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", chain: solana, token: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", name: null, symbol: null, decimals: null, block_number: 7}
```

- [ ] **Step 3: See both tests fail**

Run: `dbt parse` and then `cd orchestration && uv run pytest tests/test_definitions.py -q`
Expected: `dbt parse` fails because the unit test names a model that does not exist, `int_solana_spl_metadata`. pytest fails in `test_tokens_reads_each_chain_through_its_own_model` and in `test_every_asset_and_check_runs_in_a_scheduled_pipeline`, because no scheduled job selects `solana/spl_metadata` yet.

- [ ] **Step 4: Write `int_solana_spl_metadata.sql`**

Copy `int_base_erc20_metadata.sql`'s shape, with the comment `-- Solana mint metadata readings in the shape the tokens mart reads. The Token-2022 extension names a mint first, then Metaplex.` and these columns, in order: `id`, `'solana' as chain`, `mint as token`, `coalesce(token_2022_name, metaplex_name) as name`, `coalesce(token_2022_symbol, metaplex_symbol) as symbol`, `decimals`, `slot as block_number`, `_loaded_at`, from `{{ ref('stg_solana__spl_metadata') }}`. The rule takes each field on its own, so a mint whose extension has a name but no symbol shows the Metaplex symbol.

- [ ] **Step 5: Add the mart branch and update its YAML**

In `tokens.sql`, add a fourth `union all` branch: `select chain, token, name, symbol, decimals, block_number, _loaded_at from {{ ref('int_solana_spl_metadata') }}`. In `_tokens__models.yml`:
- model description: "…one row per chain and token in the addresses.json of evm-erc20-metadata and solana-spl-metadata…" (keep the rest).
- `chain` `accepted_values`: `[ethereum, arbitrum, base, solana]`.
- `token`: "The token's contract address, lowercased. On Solana, the mint as written, since base58 is case-sensitive."
- `name`, `symbol`: add "On Solana, the mint's Token-2022 metadata extension, else its Metaplex metadata account; null when neither has one."
- `decimals`: add "On Solana, the mint's decimals; null when the address is not a mint."
- `block_number`: "The block this reading was taken at. On Solana, the slot."

- [ ] **Step 6: Build and run every test**

Run: `dbt build --select +tokens`
Expected: `Completed successfully` with ERROR=0, including `a_token_2022_name_wins_over_metaplex`.

Run: `psql "postgresql://$WAREHOUSE_USER:$WAREHOUSE_PASSWORD@$WAREHOUSE_HOST:$WAREHOUSE_PORT/$WAREHOUSE_DB" -c "select token, name, symbol, decimals from analytics.tokens where chain = 'solana' order by token"`
Expected: `2b1k…GXo | PayPal USD | PYUSD | 6`, `EPjF…Dt1v | USD Coin | USDC | 6`, `Es9v…NYB | USDT | USDT | 6`.

Run: `dbt parse` and then `cd orchestration && uv run pytest tests/test_sources_json.py tests/test_definitions.py -q`
Expected: all pass, the new test included.

- [ ] **Step 7: Update the docs**

In `README.md`, change the Token metadata row to: `| Token metadata | Name, symbol and decimals of listed ERC-20 tokens on Ethereum, Arbitrum, Base and SPL tokens on Solana → \`analytics.tokens\` |`.

In `docs/architecture.md`, add a paragraph after the `evm-erc20-metadata` one (line 29). It must state these facts:
- `solana-spl-metadata` is a call source laid out like `solana-spl-balances`, and its `addresses.json` lists `mints`.
- Each run reads at the latest finalized slot and adds a reading to `raw.solana_spl_metadata`, keyed by slot and mint.
- One `getMultipleAccounts` request per mint reads the mint and its Metaplex metadata account at the same slot.
- Decimals come from the mint. Name and symbol come from two places, and the source keeps both: a Token-2022 `tokenMetadata` extension (PYUSD) and the Metaplex account (USDC, USDT). `int_solana_spl_metadata` takes the extension's first.
- Zero bytes are dropped. An address that is not a mint gets null decimals, not a failed call.
- In `analytics.tokens`, a Solana row keys on the mint as written and puts its slot in `block_number`.

- [ ] **Step 8: Commit**

```bash
git add transformation/models/intermediate/tokens transformation/models/marts/tokens \
  orchestration/tests/test_definitions.py docs/architecture.md README.md
git commit -m "feat(tokens): add solana spl metadata to analytics.tokens"
```
