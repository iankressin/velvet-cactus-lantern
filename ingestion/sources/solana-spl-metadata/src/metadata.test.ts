import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import {
  addEncoderSizePrefix,
  getAddressDecoder,
  getAddressEncoder,
  getBase64Decoder,
  getStructEncoder,
  getU32Encoder,
  getU8Encoder,
  getUtf8Encoder,
  type Address,
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
  Address,
  Address,
  Address,
  Address,
  Address,
  Address,
  Address,
];

/** A jsonParsed account as the RPC sends it. */
const account = (owner: Address, data: unknown) => ({
  lamports: 1461600,
  owner,
  executable: false,
  rentEpoch: 0,
  space: 82,
  data,
});

const mintAccount = (decimals: number, extensions?: unknown[]) =>
  account(extensions ? TOKEN_2022 : TOKEN, {
    program: extensions ? "spl-token-2022" : "spl-token",
    space: 82,
    parsed: {
      type: "mint",
      info: {
        decimals,
        freezeAuthority: null,
        isInitialized: true,
        mintAuthority: null,
        supply: "1000",
        ...(extensions && { extensions }),
      },
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
    const reply =
      "error" in entry
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

test("reads decimals from the mint, and name and symbol from its Metaplex account", async (t) => {
  const { url } = await fakeRpc(t, {
    [classic]: { mint: mintAccount(6), metaplex: metaplex(classic, "USD Coin", "USDC") },
  });

  const batch = await fetchMetadata(rpcAt(url), metadataCalls([classic]));

  assert.deepEqual(batch, {
    records: [
      {
        id: `7:${classic}`,
        callId: classic,
        data: {
          slot: 7n,
          mint: classic,
          owner_program: TOKEN,
          decimals: 6,
          ...NO_NAMES,
          metaplex_name: "USD Coin",
          metaplex_symbol: "USDC",
        },
      },
    ],
    failed: [],
  });
});

test("reads name and symbol from a Token-2022 mint's metadata extension", async (t) => {
  const pointer = { extension: "metadataPointer", state: { authority: null, metadataAddress: token2022 } };
  const { url } = await fakeRpc(t, {
    [token2022]: { mint: mintAccount(6, [pointer, tokenMetadata(token2022, "PayPal USD", "PYUSD")]) },
  });

  const batch = await fetchMetadata(rpcAt(url), metadataCalls([token2022]));

  assert.deepEqual(
    batch.records.map(({ data }) => data),
    [
      {
        slot: 7n,
        mint: token2022,
        owner_program: TOKEN_2022,
        decimals: 6,
        ...NO_NAMES,
        token_2022_name: "PayPal USD",
        token_2022_symbol: "PYUSD",
      },
    ],
  );
});

test("reads a Token-2022 mint that has an extension with no state", async (t) => {
  // The RPC writes an extension that holds no data as its tag alone, such as a soulbound mint's.
  const { url } = await fakeRpc(t, {
    [token2022]: {
      mint: mintAccount(6, [{ extension: "nonTransferable" }, tokenMetadata(token2022, "Badge", "BDG")]),
    },
  });

  const batch = await fetchMetadata(rpcAt(url), metadataCalls([token2022]));

  assert.deepEqual(batch.failed, []);
  assert.deepEqual(
    batch.records.map(({ data }) => [data.decimals, data.token_2022_name, data.token_2022_symbol]),
    [[6, "Badge", "BDG"]],
  );
});

test("keeps both names when a mint has both, for dbt to choose", async (t) => {
  const { url } = await fakeRpc(t, {
    [token2022]: {
      mint: mintAccount(6, [tokenMetadata(token2022, "PayPal USD", "PYUSD")]),
      metaplex: metaplex(token2022, "Old Name", "OLD"),
    },
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
    [
      [null, null, null, "USDC"],
      ["PayPal", null, null, null],
    ],
    "no zero byte reaches the jsonb column, and an empty name is null",
  );
});

test("records nulls when the mint has no account or is a wallet, without failing the call", async (t) => {
  const { url } = await fakeRpc(t, { [wallet]: { mint: lamportsOnly } });

  const batch = await fetchMetadata(rpcAt(url), metadataCalls([missing, wallet]));

  assert.deepEqual(batch.failed, [], "an address that is not a mint is a fact, not a failed call");
  assert.deepEqual(
    batch.records.map(({ data }) => data),
    [
      { slot: 7n, mint: missing, owner_program: null, decimals: null, ...NO_NAMES },
      { slot: 7n, mint: wallet, owner_program: SYSTEM, decimals: null, ...NO_NAMES },
    ],
  );
});

test("queues a token-program account the RPC returns unparsed, rather than record no decimals", async (t) => {
  // An RPC that cannot parse an account, such as one older than a mint's newest extension, sends base64.
  const unparsed = (owner: Address) => account(owner, ["AQID", "base64"]);
  const { url } = await fakeRpc(t, {
    [classic]: { mint: unparsed(TOKEN) },
    [token2022]: { mint: unparsed(TOKEN_2022) },
  });

  const batch = await fetchMetadata(rpcAt(url), metadataCalls([classic, token2022]));

  assert.deepEqual(batch.records, [], "a null reading would replace the mint's good decimals in analytics.tokens");
  assert.deepEqual(
    batch.failed.map(({ id }) => id),
    [classic, token2022],
  );
});

test("records null Metaplex names when its address holds only lamports", async (t) => {
  const { url } = await fakeRpc(t, { [classic]: { mint: mintAccount(6), metaplex: lamportsOnly } });

  const batch = await fetchMetadata(rpcAt(url), metadataCalls([classic]));

  assert.deepEqual(batch.failed, []);
  assert.deepEqual(
    batch.records.map(({ data }) => [data.decimals, data.metaplex_name]),
    [[6, null]],
  );
});

test("queues a Metaplex account it cannot decode for retry", async (t) => {
  const { url } = await fakeRpc(t, {
    [classic]: { mint: mintAccount(6), metaplex: metaplex(classic, "USD Coin", "USDC", 7) },
    [broken]: { mint: mintAccount(6), metaplex: account(METAPLEX_PROGRAM, ["BAEC", "base64"]) },
  });

  const batch = await fetchMetadata(rpcAt(url), metadataCalls([classic, broken]));

  assert.deepEqual(batch.records, []);
  assert.deepEqual(
    batch.failed.map(({ id }) => id),
    [classic, broken],
    "a wrong key and truncated data both wait for the next run",
  );
});

test("queues each call the RPC refuses or errors on, and keeps the others", async (t) => {
  const { url } = await fakeRpc(t, {
    [classic]: { mint: mintAccount(6) },
    [refused]: { status: 429 },
    [erroring]: { error: { code: -32602, message: "Invalid param: could not find account" } },
  });

  const batch = await fetchMetadata(rpcAt(url), metadataCalls([classic, refused, erroring]));

  assert.deepEqual(
    batch.records.map(({ id }) => id),
    [`7:${classic}`],
  );
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

  // Kit leaves out commitment "finalized", since an RPC reads at finalized when none is given.
  assert.deepEqual(
    requests.map(({ method, params }) => [method, params]),
    [["getMultipleAccounts", [[usdc, "5x38Kp4hvdomTCnCrAny4UtMUt5rQBdB6px2K1Ui45Wq"], { encoding: "jsonParsed" }]]],
    "the Metaplex address is the one mainnet holds USDC's metadata at",
  );
});
