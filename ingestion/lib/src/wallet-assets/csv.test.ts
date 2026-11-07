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
