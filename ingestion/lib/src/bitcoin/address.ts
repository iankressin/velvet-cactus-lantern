import { Address, NETWORK, OutScript } from "@scure/btc-signer";
import * as z from "zod";

const mainnet = Address(NETWORK);

/**
 * A mainnet P2PKH, P2SH, P2WPKH, P2WSH or P2TR address, encoded again after decoding, so the
 * same wallet is always the same string: an uppercase bech32 address becomes lowercase.
 */
export const bitcoinAddress = z
  .string()
  .transform((value, ctx) => {
    try {
      return mainnet.encode(mainnet.decode(value));
    } catch {
      ctx.issues.push({ code: "custom", message: "Expected a Bitcoin address", input: value });
      return z.NEVER;
    }
  })
  .brand<"BitcoinAddress">();

export type BitcoinAddress = z.infer<typeof bitcoinAddress>;

/** The output script, as hex, that a payment to the address locks to. scantxoutset names each unspent by it. */
export const scriptPubKey = (address: BitcoinAddress): string =>
  Buffer.from(OutScript.encode(mainnet.decode(address))).toString("hex");
