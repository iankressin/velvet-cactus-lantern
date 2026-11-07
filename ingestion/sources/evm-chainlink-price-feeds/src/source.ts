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
import aggregatorAbi from "../../../../catalog/protocols/chainlink/abis/aggregator.json" with { type: "json" };

const AnswerUpdated = defineAbi(aggregatorAbi as readonly JsonAbiItem[]).events.AnswerUpdated!;

const env = z.object({
  PORTAL_URL: z.url(),
  PORTAL_API_KEY: z.string().optional(),
  START_BLOCK: z.coerce.number().int().nonnegative(),
  END_BLOCK: z.coerce.number().int().positive().optional(),
});

export type PriceFeedsEnv = z.infer<typeof env>;

export const chainName = z.string().regex(/^[a-z][a-z0-9]*$/, "Expected a chain name such as arbitrum");

function logRecord(log: DecodedEvent<Record<string, unknown>>): RawRecord {
  const id = `${log.block.number}:${log.rawEvent.logIndex}`;
  return {
    id,
    callId: id,
    data: {
      kind: "log",
      event: "AnswerUpdated",
      block_number: log.block.number,
      timestamp: log.timestamp.toISOString(),
      tx_hash: log.rawEvent.transactionHash,
      log_index: log.rawEvent.logIndex,
      contract: log.contract,
      args: log.event,
    },
  };
}

export const forChain = (chain: string): StreamSource<PriceFeedsEnv> => ({
  name: chainName.parse(chain),
  table: "chainlink_price_feeds",
  env,
  async stream(env) {
    // AnswerUpdated names no feed, only the aggregator that emitted it, so dbt maps each aggregator to its
    // feed through transformation/seeds/chainlink_feeds.csv.
    const path = `chains/${chain}/addresses.json`;
    const listed = readJson(path).aggregators;
    // With no aggregators the decoder keeps no log, yet the cursor still moves past the blocks it read.
    if (!Array.isArray(listed) || listed.length === 0) {
      throw new Error(`${path} lists no aggregators`);
    }
    const aggregators = validateEthAddressList(listed);
    const portal = portalClient(env.PORTAL_URL, env.PORTAL_API_KEY);
    const range = { from: env.START_BLOCK, to: Math.min(env.END_BLOCK ?? Infinity, await finalizedHead(portal)) };

    return evmPortalStream({
      id: `${this.name}_${this.table}`,
      portal,
      logger: logger.child({ source: this.name, table: this.table }),
      outputs: evmEventDecoder({ range, contracts: aggregators, events: { answers: AnswerUpdated } }).pipe(({ answers }) =>
        answers.map(logRecord),
      ),
    });
  },
});
