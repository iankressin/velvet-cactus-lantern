import {
  finalizedHead,
  logger,
  portalClient,
  readJson,
  type RawRecord,
  type StreamSource,
} from "@ingestion/lib";
import { validateEthAddressList } from "@ingestion/lib/evm";
import {
  commonAbis,
  evmEventDecoder,
  evmPortalStream,
  type DecodedEvent,
  type IndexedParamsInput,
} from "@subsquid/pipes/evm";
import * as z from "zod";

const env = z.object({
  // The chain's Portal dataset, set in chains/<chain>/.env.example.
  PORTAL_URL: z.url(),
  // Sent with every Portal request when set. Without one, the public Portal answers at its anonymous limits.
  PORTAL_API_KEY: z.string().optional(),
  // Where the first run starts. Later runs resume after the cursor Pipes keeps in the warehouse.
  START_BLOCK: z.coerce.number().int().nonnegative(),
});

export type TransfersEnv = z.infer<typeof env>;

/** A chain name as SOURCES and the dbt sources spell it, such as `arbitrum`. */
export const chainName = z.string().regex(/^[a-z][a-z0-9]*$/, "Expected a chain name such as arbitrum");

const Transfer = commonAbis.erc20.events.Transfer;

// A log is unique by its block and its index in that block.
const toRecord = (t: DecodedEvent<ReturnType<typeof Transfer.decode>>): RawRecord => {
  const id = `${t.block.number}:${t.rawEvent.logIndex}`;
  return {
    id,
    callId: id,
    data: {
      block_number: t.block.number,
      timestamp: t.timestamp.toISOString(),
      tx_hash: t.rawEvent.transactionHash,
      log_index: t.rawEvent.logIndex,
      token: t.contract,
      from: t.event.from,
      to: t.event.to,
      value: t.event.value,
    },
  };
};

/**
 * The Transfers of the tokens in chains/<chain>/addresses.json on one EVM chain, up to Portal's
 * finalized head when the run starts. The source is named for its chain, so each chain loads into
 * raw.<chain>_erc20_transfers with a cursor of its own.
 *
 * With `wallets` in addresses.json, only transfers into or out of those wallets. A transfer between
 * two of them is in both outputs, under the same id, so the warehouse keeps one row. Without
 * `wallets`, every transfer of the tokens.
 */
export const forChain = (chain: string): StreamSource<TransfersEnv> => ({
  name: chainName.parse(chain),
  table: "erc20_transfers",
  env,
  async stream(env) {
    // Read inside the run, not at import, so runSource reports a bad addresses.json.
    const addresses = readJson(`chains/${chain}/addresses.json`);
    const tokens = validateEthAddressList(addresses.tokens);
    if (addresses.wallets?.length === 0) {
      throw new Error(`chains/${chain}/addresses.json lists no wallets; leave the key out to read every transfer`);
    }
    const wallets = addresses.wallets && validateEthAddressList(addresses.wallets).map((a: string) => a.toLowerCase());
    const portal = portalClient(env.PORTAL_URL, env.PORTAL_API_KEY);
    const range = { from: env.START_BLOCK, to: await finalizedHead(portal) };

    // One decoder per filter: Pipes refuses two filters on the same event in one decoder (E0004).
    const transfers = (params: IndexedParamsInput<typeof Transfer>) =>
      evmEventDecoder({ range, contracts: tokens, events: { transfers: { event: Transfer, params } } }).pipe(
        ({ transfers }) => transfers.map(toRecord),
      );

    return evmPortalStream({
      id: `${this.name}_${this.table}`,
      portal,
      logger: logger.child({ source: this.name, table: this.table }),
      outputs: wallets
        ? { incoming: transfers({ to: wallets }), outgoing: transfers({ from: wallets }) }
        : { all: transfers({}) },
    });
  },
});
