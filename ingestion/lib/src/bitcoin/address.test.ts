import assert from "node:assert/strict";
import { test } from "node:test";
import { scriptPubKey, validateBitcoinAddressList } from "#src/bitcoin/address.ts";
import { nodeScripts } from "#src/bitcoin/node-scripts.fixture.ts";

test("derives the scriptPubKey a node gives for each address type", () => {
  for (const [type, { address, script }] of Object.entries(nodeScripts)) {
    const [wallet] = validateBitcoinAddressList([address]);
    assert.equal(scriptPubKey(wallet!), script, type);
  }
});

test("keeps an uppercase bech32 address in lowercase", () => {
  const { address } = nodeScripts.p2wsh;
  assert.deepEqual(validateBitcoinAddressList([address.toUpperCase()]), [address]);
});

test("lists every address that is not a mainnet address", () => {
  const testnet = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";
  const mixedCase = "bc1qM34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h";
  assert.throws(
    () => validateBitcoinAddressList(["not-an-address", nodeScripts.p2pkh.address, testnet, mixedCase]),
    { message: `Invalid Bitcoin addresses:\n  not-an-address\n  ${testnet}\n  ${mixedCase}` },
  );
});
