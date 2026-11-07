import {
  finalizedHead,
  logger,
  portalClient,
  readJson,
  type RawRecord,
  type StreamSource,
} from "@ingestion/lib";
import { validateEthAddressList } from "@ingestion/lib/evm";
import { defineAbi, evmEventDecoder, evmPortalStream, type DecodedEvent, type JsonAbiItem } from "@subsquid/pipes/evm";
import * as z from "zod";
import gatewayAbi from "../../../../catalog/protocols/arbitrum-token-bridge/abis/l2-gateway.json" with { type: "json" };

// The catalog's ABI files are JSON, so their events are typed by name only.
const events = defineAbi(gatewayAbi as readonly JsonAbiItem[]).events;

const env = z.object({
  PORTAL_URL: z.url().default("https://portal.sqd.dev/datasets/arbitrum-one"),
  // Sent with every Portal request when set. Without one, the public Portal answers at its anonymous limits.
  PORTAL_API_KEY: z.string().optional(),
  // Where the first run starts. Later runs resume after the cursor Pipes keeps in the warehouse.
  START_BLOCK: z.coerce.number().int().nonnegative(),
  // The last block to read, set only to check a short window. Unset, each run ends at Portal's finalized head.
  END_BLOCK: z.coerce.number().int().positive().optional(),
});

export type TokenBridgeEnv = z.infer<typeof env>;

// Each record is one log as Portal returns it, unique by its block and its index in that block.
function logRecord(event: string, log: DecodedEvent<Record<string, unknown>>): RawRecord {
  const id = `${log.block.number}:${log.rawEvent.logIndex}`;
  return {
    id,
    callId: id,
    data: {
      kind: "log",
      event,
      block_number: log.block.number,
      timestamp: log.timestamp.toISOString(),
      tx_hash: log.rawEvent.transactionHash,
      log_index: log.rawEvent.logIndex,
      contract: log.contract,
      args: log.event,
    },
  };
}

/**
 * Every DepositFinalized of the Ethereum tokens in addresses.json and every WithdrawalInitiated, from
 * any contract, as emitted, from START_BLOCK to Portal's finalized head when the run starts.
 *
 * The query names no contract: the gateway router gives each token a gateway, the standard one unless
 * the token has its own, and every L2 gateway emits these two events. A withdrawal's token is not
 * indexed, so the query cannot filter it; dbt keeps the tokens it needs. Any contract can emit an event
 * with the same signature, so each record keeps the contract that emitted it, and dbt keeps only the
 * gateways in transformation/seeds/arbitrum_token_gateways.csv.
 */
export const source: StreamSource<TokenBridgeEnv> = {
  name: "arbitrum",
  table: "token_bridge",
  env,
  async stream(env) {
    // Read inside the run, not at import, so runSource reports a bad addresses.json.
    const addresses = readJson("addresses.json");
    const tokens = validateEthAddressList(addresses.tokens).map((a) => a.toLowerCase());
    const portal = portalClient(env.PORTAL_URL, env.PORTAL_API_KEY);
    const range = { from: env.START_BLOCK, to: Math.min(env.END_BLOCK ?? Infinity, await finalizedHead(portal)) };

    return evmPortalStream({
      id: `${this.name}_${this.table}`,
      portal,
      logger: logger.child({ source: this.name, table: this.table }),
      outputs: {
        deposits: evmEventDecoder({
          range,
          events: { logs: { event: events.DepositFinalized!, params: { l1Token: tokens } as Record<"l1Token", string[]> } },
        }).pipe(({ logs }) => logs.map((log) => logRecord("DepositFinalized", log))),
        withdrawals: evmEventDecoder({
          range,
          events: { logs: events.WithdrawalInitiated! },
        }).pipe(({ logs }) => logs.map((log) => logRecord("WithdrawalInitiated", log))),
      },
    });
  },
};
