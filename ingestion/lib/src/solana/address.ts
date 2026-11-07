import { isAddress, type Address } from "@solana/kit";
import * as z from "zod";

export const solanaAddress = z.custom<Address>(
  (value) => typeof value === "string" && isAddress(value),
  "Expected a Solana address",
);

/** Solana addresses are case-sensitive base58, so they are kept exactly as written. */
export function validateSolanaAddressList(addresses: readonly string[]): Address[] {
  const invalid = addresses.filter((address) => !isAddress(address));
  if (invalid.length > 0) {
    throw new Error(`Invalid Solana addresses:\n${invalid.map((address) => `  ${address}`).join("\n")}`);
  }
  return addresses as Address[];
}
