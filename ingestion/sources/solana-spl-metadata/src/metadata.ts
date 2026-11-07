import { settleCalls } from "@ingestion/lib";
import { solanaAddress, type SolanaClient } from "@ingestion/lib/solana";
import {
  addDecoderSizePrefix,
  address,
  getAddressDecoder,
  getAddressEncoder,
  getBase64Encoder,
  getProgramDerivedAddress,
  getStructDecoder,
  getU32Decoder,
  getU8Decoder,
  getUtf8Decoder,
  type AccountInfoBase,
  type AccountInfoWithJsonData,
  type Address,
} from "@solana/kit";
import * as z from "zod";

/** The Metaplex Token Metadata program, which keeps the name and symbol of most SPL Token mints. */
export const METAPLEX_PROGRAM = address("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

/** The first byte of a Metaplex metadata account (Key::MetadataV1). */
const METADATA_KEY = 4;

export const metadataCallSchema = z.object({
  kind: z.literal("spl_metadata"),
  mint: solanaAddress,
});

export type MetadataCall = z.infer<typeof metadataCallSchema>;

export const metadataCalls = (mints: readonly Address[]): MetadataCall[] =>
  mints.map((mint) => ({ kind: "spl_metadata", mint }));

// No slot: a Solana RPC cannot read a past slot, so a call is known by its mint, and a
// retried call reads the mint as it is now. The record id adds the slot.
const callId = (call: MetadataCall) => call.mint;

type Account = (AccountInfoBase & AccountInfoWithJsonData) | null;
type Names = { name: string | null; symbol: string | null };

const NO_NAMES: Names = { name: null, symbol: null };

/**
 * A name or symbol as text. Every zero byte is dropped: Metaplex pads names with them, and
 * Postgres rejects them in jsonb, which would fail the whole batch.
 */
const text = (value: string): string | null => value.replaceAll("\u0000", "") || null;

const names = ({ name, symbol }: { name: string; symbol: string }): Names => ({
  name: text(name),
  symbol: text(symbol),
});

const addressEncoder = getAddressEncoder();

/** Where the Metaplex program keeps a mint's metadata. */
async function metaplexAddress(mint: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: METAPLEX_PROGRAM,
    seeds: ["metadata", addressEncoder.encode(METAPLEX_PROGRAM), addressEncoder.encode(mint)],
  });
  return pda;
}

const borshString = addDecoderSizePrefix(getUtf8Decoder(), getU32Decoder());

/** The start of a Metaplex metadata account. What follows the symbol is not read. */
const metaplexDecoder = getStructDecoder([
  ["key", getU8Decoder()],
  ["updateAuthority", getAddressDecoder()],
  ["mint", getAddressDecoder()],
  ["name", borshString],
  ["symbol", borshString],
]);

/** The parts of a jsonParsed mint this source reads. A mint that does not match fails its call. */
const mintInfo = z.object({
  decimals: z.number().int().nonnegative(),
  // An extension that holds no data, such as nonTransferable, comes back with no state.
  extensions: z.array(z.object({ extension: z.string(), state: z.unknown().optional() })).optional(),
});

const tokenMetadataState = z.object({ name: z.string(), symbol: z.string() });

/** The mint's decimals and the names in its Token-2022 metadata extension. Nulls when the account is not a mint. */
function readMint(account: Account): { decimals: number | null; names: Names } {
  if (account === null || !("parsed" in account.data) || account.data.parsed.type !== "mint") {
    return { decimals: null, names: NO_NAMES };
  }
  const info = mintInfo.parse(account.data.parsed.info);
  const extension = info.extensions?.find(({ extension }) => extension === "tokenMetadata");
  return {
    decimals: info.decimals,
    names: extension ? names(tokenMetadataState.parse(extension.state)) : NO_NAMES,
  };
}

/**
 * The names in the mint's Metaplex account. None when no account is there, or when the
 * account holds only lamports, which anyone can send to any address. Throws on data that
 * does not decode as metadata, so the call is retried.
 */
function readMetaplex(account: Account): Names {
  if (account === null || account.owner !== METAPLEX_PROGRAM) return NO_NAMES;
  if ("parsed" in account.data) throw new Error("Metaplex metadata came back parsed, not as base64");
  const metadata = metaplexDecoder.decode(getBase64Encoder().encode(account.data[0]));
  if (metadata.key !== METADATA_KEY) {
    throw new Error(`Metaplex account has key ${metadata.key}, not ${METADATA_KEY}`);
  }
  return names(metadata);
}

/** The mint and its Metaplex account, read in one request at one slot. */
async function readMetadata(rpc: SolanaClient, call: MetadataCall) {
  const { context, value } = await rpc
    .getMultipleAccounts([call.mint, await metaplexAddress(call.mint)], {
      commitment: "finalized",
      encoding: "jsonParsed",
    })
    .send();
  const [mintAccount = null, metaplexAccount = null] = value;
  const mint = readMint(mintAccount);
  const metaplex = readMetaplex(metaplexAccount);

  return {
    slot: context.slot,
    mint: call.mint,
    owner_program: mintAccount?.owner ?? null,
    decimals: mint.decimals,
    token_2022_name: mint.names.name,
    token_2022_symbol: mint.names.symbol,
    metaplex_name: metaplex.name,
    metaplex_symbol: metaplex.symbol,
  };
}

/**
 * One getMultipleAccounts request per mint. Both places a mint's name can live are kept,
 * the Token-2022 extension and the Metaplex account; dbt chooses between them.
 */
export const fetchMetadata = (rpc: SolanaClient, calls: readonly MetadataCall[]) =>
  settleCalls(
    calls,
    callId,
    (call) => readMetadata(rpc, call),
    (call, { slot }) => `${slot}:${callId(call)}`,
  );
