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
import bridgeAbi from "../../../../catalog/protocols/op-standard-bridge/abis/l2-standard-bridge.json" with { type: "json" };

// Each chain's L2StandardBridge, from catalog/protocols/op-standard-bridge/protocol.yaml. A folder in
// chains/ needs its chain here. The bridge is a predeploy, which burns a token on withdrawal and mints it
// on deposit. Its legacy WithdrawalInitiated and DepositFinalized repeat the two events below with the
// same values, so only these two are read.
export const BRIDGES: Record<string, string> = {
  base: "0x4200000000000000000000000000000000000010",
};
const EVENTS = ["ERC20BridgeInitiated", "ERC20BridgeFinalized"] as const;
// The catalog's ABI files are JSON, so their events are typed by name only.
const events = defineAbi(bridgeAbi as readonly JsonAbiItem[]).events;

const env = z.object({
  // The chain's Portal dataset, set in chains/<chain>/.env.example.
  PORTAL_URL: z.url(),
  // Sent with every Portal request when set. Without one, the public Portal answers at its anonymous limits.
  PORTAL_API_KEY: z.string().optional(),
  // Where the first run starts. Later runs resume after the cursor Pipes keeps in the warehouse.
  START_BLOCK: z.coerce.number().int().nonnegative(),
  // The last block to read, set only to check a short window. Unset, each run ends at Portal's finalized head.
  END_BLOCK: z.coerce.number().int().positive().optional(),
});

export type StandardBridgeEnv = z.infer<typeof env>;

/** A chain name as SOURCES and the dbt sources spell it, such as `base`. */
export const chainName = z.string().regex(/^[a-z][a-z0-9]*$/, "Expected a chain name such as base");

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
 * The bridge's ERC20BridgeInitiated and ERC20BridgeFinalized logs of the tokens in
 * chains/<chain>/addresses.json on one OP Stack chain, as emitted, from START_BLOCK to Portal's finalized
 * head when the run starts. The filter is on localToken: another token on the chain can name the same
 * remote token. The source is named for its chain, so each chain loads into raw.<chain>_op_standard_bridge
 * with a cursor of its own.
 */
export const forChain = (chain: string): StreamSource<StandardBridgeEnv> => {
  const bridge = BRIDGES[chainName.parse(chain)];
  if (!bridge) {
    throw new Error(
      `No OP Standard Bridge on ${chain}: add its L2StandardBridge to BRIDGES from catalog/protocols/op-standard-bridge/protocol.yaml`,
    );
  }
  return {
    name: chain,
    table: "op_standard_bridge",
    env,
    async stream(env) {
      // Read inside the run, not at import, so runSource reports a bad addresses.json.
      const addresses = readJson(`chains/${chain}/addresses.json`);
      const tokens = validateEthAddressList(addresses.tokens).map((a) => a.toLowerCase());
      const portal = portalClient(env.PORTAL_URL, env.PORTAL_API_KEY);
      const range = { from: env.START_BLOCK, to: Math.min(env.END_BLOCK ?? Infinity, await finalizedHead(portal)) };

      // One decoder per event: Pipes refuses two filters on the same event in one decoder (E0004).
      const decoder = (event: (typeof EVENTS)[number]) =>
        evmEventDecoder({
          range,
          contracts: [bridge],
          events: { logs: { event: events[event]!, params: { localToken: tokens } as Record<"localToken", string[]> } },
        }).pipe(({ logs }) => logs.map((log) => logRecord(event, log)));

      return evmPortalStream({
        id: `${chain}_op_standard_bridge`,
        portal,
        logger: logger.child({ source: chain, table: "op_standard_bridge" }),
        outputs: { initiated: decoder("ERC20BridgeInitiated"), finalized: decoder("ERC20BridgeFinalized") },
      });
    },
  };
};
