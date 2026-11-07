# Wallet Asset CSV Reader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `readWalletAssets(path, blockchain, assetType?)` to `@ingestion/lib/wallet-assets`. It reads one chain's wallet assets, and optionally one asset type's, from a CSV of blockchain, wallet and token rows. Each balance source can then read its own share of one shared file.

**Architecture:** Two files in `ingestion/lib/src/wallet-assets/`. `csv.ts` turns CSV text into rows keyed by camelCase column names. It knows nothing about chains, and it fails only on problems with the whole file. `wallet-assets.ts` picks the rows for one chain and asset type, then checks and normalizes them with the address validators the lib already has. A bad row fails only the read that picks it, so one bad Bitcoin row stops the Bitcoin source and no other. Rows on an unknown chain, and repeated rows, log a warning. The module gets its own subpath export, not the root `.` export, so sources that import `@ingestion/lib` do not load `@solana/kit` and `@scure/btc-signer`.

**Tech Stack:** TypeScript on Node 24, the pnpm workspace in `ingestion/`, `csv-parse` 7 (new), viem, `@solana/kit`, `@scure/btc-signer`, pino (through `#src/logger.ts`), `node:test` run by tsx.

**Spec:** `/Users/ianguimaraes/Projects/am/take-home/description.md`, the take-home brief one folder above the repo root. This plan covers its input CSV and its chain and asset rules.

## Setup

- [ ] Create the worktree with superpowers:using-git-worktrees: branch `feat/wallet-assets-csv` from `main`.
- [ ] Install packages, which a new worktree lacks: `cd ingestion && pnpm install`.
- [ ] Record the baseline: `cd ingestion && pnpm --filter @ingestion/lib test && pnpm typecheck`. Note any failure that exists before you start, so no one blames it on this work.
- [ ] This plan is not committed. Read it from the main checkout at `docs/superpowers/plans/2026-11-07-wallet-assets-csv-reader.md`.

## Global Constraints

- Input: "a CSV containing blockchain, wallet address, and token address combinations." The columns are `blockchain`, `wallet_address` and `token_address`, the names the spec gives the output columns, so the output can echo them.
- Chains and assets: "Ethereum: Native ETH and ERC-20 tokens", "Solana: Native SOL and SPL tokens", "Bitcoin: Native BTC". "Bitcoin wallets will require only a BTC balance." So the asset types are `ethereum`: `native`, `erc20`; `solana`: `native`, `spl`; `bitcoin`: `native`. These match `asset_type` in the dbt balance models.
- Size: "approximately 250 wallets across Ethereum, Solana, and Bitcoin, with 1–10 assets per wallet, including the native asset". That is about 2,500 rows at most, so read the whole file at once.
- Output (later work): "one row per requested wallet and asset combination". A read returns each combination once, where the file first lists it.
- One bad row fails only the read that picks it. Problems with the whole file (BOM, bad CSV syntax, empty, missing columns, no rows) fail every read.
- Column names become camelCase keys (`wallet_address` → `walletAddress`). Messages name columns as the file spells them, since a person fixes the file.
- The reader takes the CSV as written. It does not strip a BOM, trim cells, fold case or skip blank rows. It rejects a BOM with an error that names it.
- Chain names are lowercase, as `ingestion/sources.json` and dbt spell them: `ethereum`, `solana`, `bitcoin`. Only these three for now; other EVM chains come later.
- Addresses come out in the form the raw tables store: Ethereum lowercase (`toLower`, `lib/src/evm/address.ts`), Solana exactly as written, Bitcoin re-encoded by `bitcoinAddress` (`lib/src/bitcoin/address.ts`).
- Warnings go through `logger` from `#src/logger.ts`, which writes JSON lines to stdout for Dagster to read.
- `csv-parse` `^7.0.3` is the only new dependency, added to `@ingestion/lib`.
- `ingestion/tsconfig.json` is strict, with `noUncheckedIndexedAccess` and `erasableSyntaxOnly` (no enums, namespaces or parameter properties). Imports inside lib use `#src/<path>.ts`.
- Tests use `node:test` and `node:assert/strict`, as `lib/src/bitcoin/address.test.ts` does.
- Prose in doc comments and the glossary: short words, active voice, no stock phrases.

## Review Focus

1. A bad row on one chain or asset type. Every other read of the same file should still succeed. Test: Task 3, "fails only the read whose rows are bad".
2. A file saved by Excel as "CSV UTF-8", which starts with a BOM. The error should name the BOM, not report a missing `blockchain` column. Test: Task 1.
3. A mistyped chain (`Ethereum`). No source reads the row, so every read should warn with its line rather than drop it in silence. Test: Task 3.
4. One wallet and token listed twice, once checksummed and once lowercase. It should give one wallet asset and a warning that names both lines. Test: Task 3.
5. A Bitcoin row with no trailing comma (`bitcoin,bc1q…`). Only the Bitcoin read should fail, naming the line and its cell count. Test: Task 3.

## Out of Scope

- Switching the five balance sources to this reader: a `WALLET_ASSETS_CSV` path in their env, and `balanceCallsAt` taking wallet assets instead of every wallet against every token.
- Chains other than `ethereum`, `solana` and `bitcoin`.
- Cleaning up spreadsheet exports: stripping a BOM, trimming spaces, folding case, skipping blank rows.
- The output CSV, `balance_tokens` and token decimals.
- The 250-wallet example input and the README's input format section. They belong with the command that runs the whole job.

## File Structure

- Create `ingestion/lib/src/wallet-assets/csv.ts`: CSV text to rows keyed by camelCase column names, and the errors about the whole file.
- Create `ingestion/lib/src/wallet-assets/csv.test.ts`.
- Create `ingestion/lib/src/wallet-assets/wallet-assets.ts`: the `WalletAsset` types, the chain rules, `parseWalletAssets` and `readWalletAssets`.
- Create `ingestion/lib/src/wallet-assets/wallet-assets.test.ts`.
- Create `ingestion/lib/src/wallet-assets/index.ts`: the public exports.
- Create `ingestion/lib/src/wallet-assets/example.csv`: a small valid file that shows the format.
- Modify `ingestion/lib/package.json`: the `./wallet-assets` export and the `csv-parse` dependency. `ingestion/pnpm-lock.yaml` changes with it.
- Modify `GLOSSARY.md`: add the term **Wallet asset**.

---

### Task 1: Read CSV text into rows

**Files:**
- Modify: `ingestion/lib/package.json`, `ingestion/pnpm-lock.yaml` (through pnpm)
- Create: `ingestion/lib/src/wallet-assets/csv.ts`
- Test: `ingestion/lib/src/wallet-assets/csv.test.ts`

**Interfaces:**
- Consumes: `parse` from `csv-parse/sync`.
- Produces, in `csv.ts`:

```ts
export type CsvRow = {
  /** The line the row ends on. The header is line 1. */
  line: number;
  /** How many cells the row has. A short or long row differs from the header's column count. */
  cellCount: number;
  /** The row's cells under their camelCase column names. A short row lacks its last columns; a long row's extra cells are dropped. */
  record: Record<string, string>;
};

/** `columns` holds the header's names in camelCase. */
export type CsvTable = { columns: string[]; rows: CsvRow[] };

/** `required` names columns as the file spells them. `file` names the input in errors. */
export function parseCsv(text: string, file: string, required: readonly string[]): CsvTable;
```

- `parseCsv` throws these errors, exactly, checked in this order:
  - `${file} starts with a byte order mark (BOM); save it as UTF-8 without one`
  - `${file} is not valid CSV: <csv-parse's message>`
  - `${file} is empty`
  - `${file} is missing columns: <names>`, the missing names from `required`, comma-separated, in the order of `required`
  - `${file} has no rows`, for a header with no rows

- [ ] **Step 1: Add the dependency**

Run: `cd ingestion && pnpm add csv-parse@^7.0.3 --filter @ingestion/lib`
Expected: `lib/package.json` lists `"csv-parse": "^7.0.3"` and `pnpm-lock.yaml` changes.

- [ ] **Step 2: Write the failing tests** in `ingestion/lib/src/wallet-assets/csv.test.ts`

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCsv } from "#src/wallet-assets/csv.ts";

const HEADER = "blockchain,wallet_address,token_address";
const parse = (text: string) => parseCsv(text, "wallets.csv", ["blockchain", "wallet_address", "token_address"]);

test("keys each cell by its column name in camelCase, with the line the row is on", () => {
  assert.deepEqual(
    parse(`${HEADER},wallet_label\nbitcoin,1A1z,,cold\n\nsolana,abc,def,"hot, main"\n`),
    {
      columns: ["blockchain", "walletAddress", "tokenAddress", "walletLabel"],
      rows: [
        { line: 2, cellCount: 4, record: { blockchain: "bitcoin", walletAddress: "1A1z", tokenAddress: "", walletLabel: "cold" } },
        { line: 3, cellCount: 1, record: { blockchain: "" } },
        { line: 4, cellCount: 4, record: { blockchain: "solana", walletAddress: "abc", tokenAddress: "def", walletLabel: "hot, main" } },
      ],
    },
  );
});

test("keeps a short or long row with its cell count, so the caller decides whether it fails", () => {
  assert.deepEqual(parse(`${HEADER}\nbitcoin,1A1z\nethereum,0xa,0xb,extra\n`).rows, [
    { line: 2, cellCount: 2, record: { blockchain: "bitcoin", walletAddress: "1A1z" } },
    { line: 3, cellCount: 4, record: { blockchain: "ethereum", walletAddress: "0xa", tokenAddress: "0xb" } },
  ]);
});

test("names the file and the problem when it cannot read the file as a table", () => {
  assert.throws(() => parse(`﻿${HEADER}\nbitcoin,1A1z,\n`), {
    message: "wallets.csv starts with a byte order mark (BOM); save it as UTF-8 without one",
  });
  assert.throws(() => parse(`${HEADER}\nbitcoin,"1A1z,\n`), {
    message: /^wallets\.csv is not valid CSV: Quote Not Closed/,
  });
  assert.throws(() => parse(""), { message: "wallets.csv is empty" });
  assert.throws(() => parse("blockchain,wallet\nbitcoin,x\n"), {
    message: "wallets.csv is missing columns: wallet_address, token_address",
  });
  assert.throws(() => parse(`${HEADER}\n`), { message: "wallets.csv has no rows" });
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `cd ingestion && pnpm exec tsx --test lib/src/wallet-assets/csv.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `#src/wallet-assets/csv.ts`.

- [ ] **Step 4: Implement `parseCsv` in `csv.ts`**

Check for a BOM (`text.startsWith("﻿")`) before parsing. Parse with `parse(text, { info: true, relax_column_count: true })` and no `columns` option. Each item is then `{ record: string[], info }`, with `info.lines` the line the record ends on. With `relax_column_count`, a short or long row comes back instead of failing the whole file. The first item is the header. Turn each header name into camelCase with `name.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase())`. Check `required` against the header as the file spells it. Catch csv-parse's `CsvError` and rethrow it in the "not valid CSV" form.

- [ ] **Step 5: Run the tests to see them pass**

Run: `cd ingestion && pnpm exec tsx --test lib/src/wallet-assets/csv.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Typecheck**

Run: `cd ingestion && pnpm typecheck`
Expected: exit 0, no errors.

- [ ] **Step 7: Commit**

```bash
git add ingestion/lib/package.json ingestion/pnpm-lock.yaml ingestion/lib/src/wallet-assets
git commit -m "feat(lib): read CSV text into rows keyed by camelCase columns"
```

---

### Task 2: Read one chain's wallet assets, by asset type

**Files:**
- Modify: `ingestion/lib/package.json`, `GLOSSARY.md`
- Create: `ingestion/lib/src/wallet-assets/wallet-assets.ts`, `ingestion/lib/src/wallet-assets/index.ts`, `ingestion/lib/src/wallet-assets/example.csv`
- Test: `ingestion/lib/src/wallet-assets/wallet-assets.test.ts`

**Interfaces:**
- Consumes: `parseCsv` and `CsvRow` from Task 1; `toLower` from `#src/evm/address.ts`; `bitcoinAddress` and `BitcoinAddress` from `#src/bitcoin/address.ts`; `isAddress` from `viem` and from `@solana/kit`.
- Produces, in `wallet-assets.ts`:

```ts
import type { Address as SolanaAddress } from "@solana/kit";
import type { Address as EvmAddress } from "viem";

/** One wallet and one asset whose balance a run reads. A native asset has no token address. */
export type WalletAsset =
  | { blockchain: "ethereum"; assetType: "native"; walletAddress: EvmAddress; tokenAddress: null }
  | { blockchain: "ethereum"; assetType: "erc20"; walletAddress: EvmAddress; tokenAddress: EvmAddress }
  | { blockchain: "solana"; assetType: "native"; walletAddress: SolanaAddress; tokenAddress: null }
  | { blockchain: "solana"; assetType: "spl"; walletAddress: SolanaAddress; tokenAddress: SolanaAddress }
  | { blockchain: "bitcoin"; assetType: "native"; walletAddress: BitcoinAddress; tokenAddress: null };

export type Blockchain = WalletAsset["blockchain"];

/** The asset types a chain has: its native asset and its token standard, if any. */
export type AssetType<B extends Blockchain = Blockchain> = Extract<WalletAsset, { blockchain: B }>["assetType"];

/** The wallet assets in CSV text on `blockchain`, of `assetType` when given. `file` names the input in errors. */
export function parseWalletAssets<B extends Blockchain, T extends AssetType<B> = AssetType<B>>(
  text: string,
  file: string,
  blockchain: B,
  assetType?: T,
): Extract<WalletAsset, { blockchain: B; assetType: T }>[];

/** The same, from the CSV file at `path`, from the working directory. */
export function readWalletAssets<B extends Blockchain, T extends AssetType<B> = AssetType<B>>(
  path: string,
  blockchain: B,
  assetType?: T,
): Extract<WalletAsset, { blockchain: B; assetType: T }>[];
```

- `index.ts` exports `readWalletAssets` and the types `WalletAsset`, `Blockchain` and `AssetType`, not `parseWalletAssets`. `ingestion/lib/package.json` `exports` gains `"./wallet-assets": "./src/wallet-assets/index.ts"`.
- How sources will call it (out of scope here): `readWalletAssets(path, "ethereum", "native")`, `(path, "ethereum", "erc20")`, `(path, "solana", "native")`, `(path, "solana", "spl")` and `(path, "bitcoin")`.

- [ ] **Step 1: Create `example.csv`**

```csv
blockchain,wallet_address,token_address
ethereum,0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045,
ethereum,0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045,0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
ethereum,0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045,0xdAC17F958D2ee523a2206206994597C13D831ec7
ethereum,0x28C6c06298d514Db089934071355E5743bf21d60,
ethereum,0x28C6c06298d514Db089934071355E5743bf21d60,0x6B175474E89094C44Da98b954EedeAC495271d0F
solana,9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM,
solana,9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM,EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
solana,9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM,Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB
bitcoin,bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h,
bitcoin,1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa,
```

- [ ] **Step 2: Write the failing tests** in `ingestion/lib/src/wallet-assets/wallet-assets.test.ts`

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseWalletAssets, readWalletAssets } from "#src/wallet-assets/wallet-assets.ts";

const HEADER = "blockchain,wallet_address,token_address";
const csv = (...rows: string[]) => [HEADER, ...rows].join("\n") + "\n";

const vitalik = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const usdc = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const solWallet = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const solUsdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const btcWallet = "bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h";

const ethNative = { blockchain: "ethereum", assetType: "native", walletAddress: vitalik.toLowerCase(), tokenAddress: null };
const ethErc20 = { blockchain: "ethereum", assetType: "erc20", walletAddress: vitalik.toLowerCase(), tokenAddress: usdc.toLowerCase() };
const solNative = { blockchain: "solana", assetType: "native", walletAddress: solWallet, tokenAddress: null };
const solSpl = { blockchain: "solana", assetType: "spl", walletAddress: solWallet, tokenAddress: solUsdc };
const btcNative = { blockchain: "bitcoin", assetType: "native", walletAddress: btcWallet, tokenAddress: null };

const mixed = csv(
  `ethereum,${vitalik},`,
  `solana,${solWallet},${solUsdc}`,
  `ethereum,${vitalik},${usdc}`,
  `bitcoin,${btcWallet.toUpperCase()},`,
  `solana,${solWallet},`,
);

test("reads every asset type of the chain when no asset type is given", () => {
  assert.deepEqual(parseWalletAssets(mixed, "wallets.csv", "ethereum"), [ethNative, ethErc20]);
  assert.deepEqual(parseWalletAssets(mixed, "wallets.csv", "solana"), [solSpl, solNative]);
});

test("reads only the asset type asked for", () => {
  assert.deepEqual(parseWalletAssets(mixed, "wallets.csv", "ethereum", "native"), [ethNative]);
  assert.deepEqual(parseWalletAssets(mixed, "wallets.csv", "ethereum", "erc20"), [ethErc20]);
  assert.deepEqual(parseWalletAssets(mixed, "wallets.csv", "solana", "native"), [solNative]);
  assert.deepEqual(parseWalletAssets(mixed, "wallets.csv", "solana", "spl"), [solSpl]);
});

test("re-encodes an uppercase bech32 Bitcoin address in lowercase", () => {
  assert.deepEqual(parseWalletAssets(mixed, "wallets.csv", "bitcoin"), [btcNative]);
});

test("reads each source's share of the example file", () => {
  const example = fileURLToPath(new URL("./example.csv", import.meta.url));
  assert.equal(readWalletAssets(example, "ethereum", "native").length, 2);
  assert.equal(readWalletAssets(example, "ethereum", "erc20").length, 3);
  assert.equal(readWalletAssets(example, "solana", "native").length, 1);
  assert.equal(readWalletAssets(example, "solana", "spl").length, 2);
  assert.equal(readWalletAssets(example, "bitcoin").length, 2);
});

// Checked by `pnpm typecheck`, never run: each chain offers only its own asset types,
// and the asset type narrows what comes back.
export const typeChecks = (path: string) => {
  // @ts-expect-error Bitcoin has only its native asset.
  readWalletAssets(path, "bitcoin", "erc20");
  // @ts-expect-error Ethereum tokens are erc20.
  readWalletAssets(path, "ethereum", "spl");
  // @ts-expect-error Solana tokens are spl.
  readWalletAssets(path, "solana", "erc20");
  const tokens: { tokenAddress: `0x${string}` }[] = readWalletAssets(path, "ethereum", "erc20");
  return tokens;
};
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `cd ingestion && pnpm exec tsx --test lib/src/wallet-assets/wallet-assets.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `#src/wallet-assets/wallet-assets.ts`.

- [ ] **Step 4: Implement `wallet-assets.ts` and `index.ts`, and add the export to `package.json`**

Read rows with `parseCsv(text, file, ["blockchain", "wallet_address", "token_address"])`. Keep the chain rules in one table keyed by `Blockchain`, not in branches. Each entry holds:
- the address noun for messages (`"an Ethereum address"`, `"a Solana address"`, `"a Bitcoin address"`)
- the native symbol (`ETH`, `SOL`, `BTC`)
- the token asset type (`erc20`, `spl`, or none for Bitcoin)
- `address(value: string): string | null`, which returns the stored form, or null when `value` is not an address on that chain

Task 3 builds its messages from this table.

Pick rows before checking them, since a bad row must fail only the read that picks it:
- A row's chain is its `blockchain` cell, compared exactly.
- A row's asset type is `native` when `tokenAddress` is empty or missing. Otherwise it is the chain's token type.
- A read picks a row when its chain is `blockchain` and, when `assetType` is given, its asset type is `assetType`.
- A token row on a chain without tokens (Bitcoin) counts as part of every read of that chain, so its error reaches that chain's source in Task 3.

In this task, assume every picked row is valid and distinct. Normalize each one and return them in file order.

`readWalletAssets` reads the file as UTF-8 and calls `parseWalletAssets(text, path, blockchain, assetType)`. Its doc comment states the format:
- the three columns, found by name in any order, with other columns ignored
- an empty `token_address` means the chain's native asset
- Bitcoin rows take no token
- the file must be plain UTF-8 CSV, without a BOM

Like `readJson`, the comment says to call it inside a run, so `runSource` logs a bad file.

- [ ] **Step 5: Add the glossary term** to `GLOSSARY.md`, under `### Ingestion`, after **Run**

```markdown
**Wallet asset**:
One wallet and one asset on one chain whose balance a run reads, such as a wallet's USDC on Ethereum. Its asset type is native, or the chain's token standard (erc20, spl). A wallet asset CSV lists one per row, and each balance source reads the rows of its own chain and asset type.
_Avoid_: holding, position, pair
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `cd ingestion && pnpm exec tsx --test lib/src/wallet-assets/wallet-assets.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 7: Typecheck**

Run: `cd ingestion && pnpm typecheck`
Expected: exit 0, no errors. An "Unused '@ts-expect-error' directive" error means a chain accepts an asset type it should not.

- [ ] **Step 8: Prove a source package can import the subpath**

Run: `cd ingestion/sources/bitcoin-btc-balances && node --import tsx --input-type=module -e "const m = await import('@ingestion/lib/wallet-assets'); console.log(Object.keys(m).sort().join(','))"`
Expected: `readWalletAssets`

- [ ] **Step 9: Commit**

```bash
git add ingestion/lib/package.json ingestion/lib/src/wallet-assets GLOSSARY.md
git commit -m "feat(lib): read one chain's wallet assets from a CSV file, by asset type"
```

---

### Task 3: Fail only the read with bad rows, and warn about the rest

**Files:**
- Modify: `ingestion/lib/src/wallet-assets/wallet-assets.ts`
- Test: `ingestion/lib/src/wallet-assets/wallet-assets.test.ts`

**Interfaces:**
- Consumes: Task 2's chain table and row picking; `logger` from `#src/logger.ts`.
- Produces: a fifth parameter on `parseWalletAssets`, `warn: (message: string) => void = (message) => logger.warn(message)`. `readWalletAssets` keeps its signature and uses the default.
- In this order, `parseWalletAssets`:
  1. Warns once when rows name an unknown chain: `Rows in ${file} that no source reads:` then `  line ${n}: blockchain "${value}" is not ethereum, solana or bitcoin` per row. Every read gives this warning, whatever its chain.
  2. Throws once when picked rows are bad: `Invalid ${blockchain} rows in ${file}:`, or `Invalid ${blockchain} ${assetType} rows in ${file}:` when `assetType` is given, then `  line ${n}: ${problem}` per problem, in file order. Rows it did not pick never fail it.
  3. Warns once when picked rows repeat a wallet asset (equal after normalizing): `Repeated rows in ${file}, read once each:` then `  line ${n} repeats line ${first}` per dropped row. It keeps the first.

- [ ] **Step 1: Write the failing tests** (append to `wallet-assets.test.ts`)

```ts
const noWarnings = (message: string) => assert.fail(`unexpected warning: ${message}`);
const badChecksum = "0xa0B86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const testnet = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";

const withBadRows = csv(
  `ethereum,${vitalik},`,
  `ethereum,0x123,`,
  `ethereum,0x456,ETH`,
  `ethereum,${badChecksum},${usdc}`,
  `solana,${solWallet},`,
  `solana,${solWallet},SOL`,
  `bitcoin,${btcWallet},${usdc}`,
  `bitcoin,${btcWallet}`,
  `bitcoin,${testnet},`,
);

test("fails only the read whose rows are bad, listing each problem by line", () => {
  const read = (blockchain: Blockchain, assetType?: AssetType) =>
    parseWalletAssets(withBadRows, "wallets.csv", blockchain, assetType, noWarnings);

  assert.throws(() => read("ethereum", "native"), {
    message: 'Invalid ethereum native rows in wallets.csv:\n  line 3: wallet_address "0x123" is not an Ethereum address',
  });
  assert.throws(() => read("ethereum", "erc20"), {
    message: [
      "Invalid ethereum erc20 rows in wallets.csv:",
      '  line 4: wallet_address "0x456" is not an Ethereum address',
      '  line 4: token_address "ETH" is not an Ethereum address; leave it empty for ETH',
      `  line 5: wallet_address "${badChecksum}" is not an Ethereum address`,
    ].join("\n"),
  });
  assert.throws(() => read("ethereum"), { message: /^Invalid ethereum rows in wallets\.csv:\n  line 3: .*\n  line 4: .*\n  line 4: .*\n  line 5: / });
  assert.deepEqual(read("solana", "native"), [solNative]);
  assert.throws(() => read("solana", "spl"), {
    message: 'Invalid solana spl rows in wallets.csv:\n  line 7: token_address "SOL" is not a Solana address; leave it empty for SOL',
  });
  assert.throws(() => read("bitcoin"), {
    message: [
      "Invalid bitcoin rows in wallets.csv:",
      "  line 8: bitcoin has no tokens; leave token_address empty",
      "  line 9: has 2 cells; the header has 3",
      `  line 10: wallet_address "${testnet}" is not a Bitcoin address`,
    ].join("\n"),
  });
});

test("warns in every read about rows on a chain no source reads", () => {
  const warnings: string[] = [];
  const text = csv(`Ethereum,${vitalik},`, `ethereum,${vitalik},`);
  assert.deepEqual(parseWalletAssets(text, "wallets.csv", "ethereum", "native", (m) => warnings.push(m)), [ethNative]);
  assert.deepEqual(parseWalletAssets(text, "wallets.csv", "bitcoin", undefined, (m) => warnings.push(m)), []);
  const warning = 'Rows in wallets.csv that no source reads:\n  line 2: blockchain "Ethereum" is not ethereum, solana or bitcoin';
  assert.deepEqual(warnings, [warning, warning]);
});

test("reads a repeated wallet asset once and warns with the lines that repeat it", () => {
  const warnings: string[] = [];
  const text = csv(
    `ethereum,${vitalik},${usdc}`,
    `ethereum,${vitalik},`,
    `ethereum,${vitalik.toLowerCase()},${usdc.toLowerCase()}`,
    `ethereum,${vitalik},`,
  );
  assert.deepEqual(parseWalletAssets(text, "wallets.csv", "ethereum", undefined, (m) => warnings.push(m)), [ethErc20, ethNative]);
  assert.deepEqual(warnings, [
    "Repeated rows in wallets.csv, read once each:\n  line 4 repeats line 2\n  line 5 repeats line 3",
  ]);
});
```

Add `type AssetType, type Blockchain` to the `#src/wallet-assets/wallet-assets.ts` import.

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd ingestion && pnpm exec tsx --test lib/src/wallet-assets/wallet-assets.test.ts`
Expected: the 3 new tests FAIL. Bad rows give a TypeError or ZodError instead of the listed message; no warnings arrive; the repeat read returns 4 assets. Task 2's 4 tests pass.

- [ ] **Step 3: Add the checks and warnings to `parseWalletAssets`**

Check every picked row before returning anything. The problem texts, exactly as the test spells them, take their noun and symbol from the chain table:
- `has <cellCount> cells; the header has <columns.length>`. When a row has the wrong cell count, report only this, since its cells may sit under the wrong columns.
- `wallet_address "<value>" is not <noun>`
- `token_address "<value>" is not <noun>; leave it empty for <symbol>`
- `bitcoin has no tokens; leave token_address empty`, for a token on a chain with no token type.

Check a row's wallet and token separately, so one row can report both. Find repeats only once every picked row is valid, with a `Map` from `` `${walletAddress}:${tokenAddress ?? ""}` `` to the first line.

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd ingestion && pnpm exec tsx --test lib/src/wallet-assets/wallet-assets.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Run the lib suite and typecheck**

Run: `cd ingestion && pnpm --filter @ingestion/lib test && pnpm typecheck`
Expected: every lib test passes, apart from failures recorded at Setup; typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add ingestion/lib/src/wallet-assets
git commit -m "feat(lib): fail only the wallet asset read with bad rows, and warn about the rest"
```
