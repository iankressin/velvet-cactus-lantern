import assert from "node:assert/strict";
import { test } from "node:test";
import { bitcoinAddress, scriptPubKey } from "#src/bitcoin/address.ts";
import { nodeScripts } from "#src/bitcoin/node-scripts.fixture.ts";

test("derives the scriptPubKey a node gives for each address type", () => {
  for (const [type, { address, script }] of Object.entries(nodeScripts)) {
    assert.equal(scriptPubKey(bitcoinAddress.parse(address)), script, type);
  }
});

test("keeps an uppercase bech32 address in lowercase", () => {
  const { address } = nodeScripts.p2wsh;
  assert.equal(bitcoinAddress.parse(address.toUpperCase()), address);
});

test("rejects anything that is not a mainnet address", () => {
  const testnet = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";
  const mixedCase = "bc1qM34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h";
  for (const address of ["not-an-address", testnet, mixedCase]) {
    assert.equal(bitcoinAddress.safeParse(address).success, false, address);
  }
});
