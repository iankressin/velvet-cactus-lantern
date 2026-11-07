import { isAddress, type Address } from "viem";
import * as z from "zod";

export const address = z.custom<Address>(
  (value) => typeof value === "string" && isAddress(value),
  "Expected an Ethereum address",
);

export const toLower = (address: Address) => address.toLowerCase() as Address;

/** Mixed-case addresses must carry a valid EIP-55 checksum; all-lowercase ones pass as is. */
export function validateAddressList(addresses: readonly string[]): Address[] {
  const invalid = addresses.filter((address) => !isAddress(address));
  if (invalid.length > 0) {
    throw new Error(`Invalid Ethereum addresses:\n${invalid.map((address) => `  ${address}`).join("\n")}`);
  }
  return addresses as Address[];
}
