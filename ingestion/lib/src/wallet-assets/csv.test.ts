import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCsv } from "#src/wallet-assets/csv.ts";

const HEADER = "blockchain,wallet_address,token_address";
const BOM = String.fromCharCode(0xfeff);
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

test("splits rows at CRLF, LF or CR, even when one file mixes them", () => {
  const rows = (text: string) =>
    parse(text).rows.map(({ line, cellCount, record }) => [line, cellCount, record.blockchain, record.tokenAddress]);
  // Rows added with LF after an Excel-style CRLF header and first row.
  assert.deepEqual(rows(`${HEADER}\r\nbitcoin,1A1z,\r\nsolana,abc,def\nethereum,0xa,\n`), [
    [2, 3, "bitcoin", ""],
    [3, 3, "solana", "def"],
    [4, 3, "ethereum", ""],
  ]);
  // An LF header with CRLF rows: no carriage return may stay in the last cell.
  assert.deepEqual(rows(`${HEADER}\nbitcoin,1A1z,\r\nsolana,abc,\r\n`), [
    [2, 3, "bitcoin", ""],
    [3, 3, "solana", ""],
  ]);
});

test("names the file and the problem when it cannot read the file as a table", () => {
  assert.throws(() => parse(`${BOM}${HEADER}\nbitcoin,1A1z,\n`), {
    message: "wallets.csv starts with a byte order mark (BOM); save it as UTF-8 without one",
  });
  assert.throws(() => parse(`${HEADER}\nbitcoin,"1A1z,\n`), {
    message: /^wallets\.csv is not valid CSV: Quote Not Closed/,
  });
  assert.throws(() => parse(""), { message: "wallets.csv is empty" });
  assert.throws(() => parse("blockchain,wallet\nbitcoin,x\n"), {
    message: 'wallets.csv is missing columns: wallet_address, token_address; its header is "blockchain,wallet"',
  });
  assert.throws(() => parse(`${HEADER}\n`), { message: "wallets.csv has no rows" });
});

test("shows the header it found when a spreadsheet split the columns some other way", () => {
  assert.throws(() => parse("blockchain;wallet_address;token_address\nbitcoin;1A1z;\n"), {
    message:
      'wallets.csv is missing columns: blockchain, wallet_address, token_address; its header is "blockchain;wallet_address;token_address"',
  });
  assert.throws(() => parse("blockchain, wallet_address, token_address\nbitcoin,1A1z,\n"), {
    message:
      'wallets.csv is missing columns: wallet_address, token_address; its header is "blockchain, wallet_address, token_address"',
  });
});

test("rejects a header that names a column twice, since one cell would hide the other", () => {
  assert.throws(() => parse(`${HEADER},token_address\nethereum,0xa,0xb,\n`), {
    message: "wallets.csv repeats columns: token_address",
  });
  assert.throws(() => parse(`${HEADER},walletAddress\nethereum,0xa,,0xb\n`), {
    message: "wallets.csv repeats columns: walletAddress",
  });
});
