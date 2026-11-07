import { existsSync } from "node:fs";
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
  contractFactory,
  contractFactorySqliteStore,
  defineAbi,
  evmEventDecoder,
  evmPortalStream,
  evmQuery,
  type DecodedEvent,
  type JsonAbiItem,
} from "@subsquid/pipes/evm";
import * as z from "zod";
import factoryAbi from "../../../../catalog/protocols/uniswap/abis/v2-factory.json" with { type: "json" };
import pairAbi from "../../../../catalog/protocols/uniswap/abis/v2-pair.json" with { type: "json" };

// Each chain's factory and the block it was deployed in. A folder in chains/ needs its chain here.
// The contract system, from catalog/protocols/uniswap/protocol.yaml: the factory, the event it emits
// for each pair it creates, the argument that holds the pair's address, and the pairs' own event.
const FACTORIES: Record<string, { address: string; deployedBlock: number }> = {
  ethereum: { address: "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f", deployedBlock: 10000835 },
};
const CREATED = "PairCreated";
const CHILD_ADDRESS = "pair";
const CHILD_EVENT = "Swap";
// The catalog's ABI files are JSON, so their events are typed by name only.
const events = (abi: readonly JsonAbiItem[]) => defineAbi(abi).events;
const factoryEvents = events(factoryAbi);
const childEvents = events(pairAbi);

const envFor = (chain: string, deployedBlock: number) =>
  z
    .object({
      // The chain's Portal dataset, set in chains/<chain>/.env.example.
      PORTAL_URL: z.url(),
      // Sent with every Portal request when set. Without one, the public Portal answers at its anonymous limits.
      PORTAL_API_KEY: z.string().optional(),
      // The first block of pool creations. A pool created before START_BLOCK still trades after it.
      POOLS_START_BLOCK: z.coerce
        .number()
        .int()
        .nonnegative()
        .default(deployedBlock),
      // The first block of Swaps. Later runs resume after the cursor Pipes keeps in the warehouse.
      START_BLOCK: z.coerce.number().int().nonnegative(),
      // The last block to read, set only to check a short window. Unset, each run ends at Portal's finalized head.
      END_BLOCK: z.coerce.number().int().positive().optional(),
      // Where Pipes' factory pattern keeps the pools it has found, relative to the package. Each chain has its own.
      FACTORY_DB: z.string().min(1).default(`chains/${chain}/factory.sqlite`),
    })
    .refine((e) => e.POOLS_START_BLOCK <= e.START_BLOCK, {
      message:
        "POOLS_START_BLOCK must not be after START_BLOCK, or the Swaps of pools created between them are lost",
    });

export type FactorySourceEnv = z.infer<ReturnType<typeof envFor>>;

type Log = Omit<DecodedEvent<Record<string, unknown>>, "factory">;

// Each record is one item as Portal returns it. A log is unique by its block and its index in that
// block, a transaction by its hash.
function logRecord(event: string, log: Log): RawRecord {
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

function transactionRecord(
  blockNumber: number,
  tx: { hash: string; from: string },
): RawRecord {
  const id = `tx:${tx.hash}`;
  return {
    id,
    callId: id,
    data: {
      kind: "transaction",
      block_number: blockNumber,
      hash: tx.hash,
      from: tx.from,
    },
  };
}

/** A chain name as SOURCES and the dbt sources spell it, such as `ethereum`. */
export const chainName = z.string().regex(/^[a-z][a-z0-9]*$/, "Expected a chain name such as ethereum");

// Uniswap v2 logs of the tokens in chains/<chain>/addresses.json, each as emitted: every PairCreated
// naming a token, from POOLS_START_BLOCK, and every Swap of those pairs, from START_BLOCK. Also the
// transactions those logs came from, as records of their own. The source is named for its chain, so
// each chain loads into raw.<chain>_uniswap_v2.
// Pipes' factory pattern follows the pairs. Which token a Swap bought is dbt's to work out.
export const forChain = (chain: string): StreamSource<FactorySourceEnv> => {
  const factory = FACTORIES[chainName.parse(chain)];
  if (!factory) {
    throw new Error(`No Uniswap v2 factory on ${chain}: add it to FACTORIES from catalog/protocols/uniswap/protocol.yaml`);
  }
  return {
    name: chain,
    table: "uniswap_v2",
    env: envFor(chain, factory.deployedBlock),
    async stream(env) {
      // Read inside the run, not at import, so runSource reports a bad addresses.json.
      const addresses = readJson(`chains/${chain}/addresses.json`);
      const tokens = validateEthAddressList(addresses.tokens).map((a) =>
        a.toLowerCase(),
      );
      const portal = portalClient(env.PORTAL_URL, env.PORTAL_API_KEY);
      const to = Math.min(env.END_BLOCK ?? Infinity, await finalizedHead(portal));
      const storeIsNew = !existsSync(env.FACTORY_DB);
      // The factories wait for the store, which opens, and so creates its file, only once the check in
      // `start` below passes. A run that check stops leaves no new file for the next run to trust.
      let openStore = () => {};
      const database = new Promise<Awaited<ReturnType<typeof contractFactorySqliteStore>>>((resolve) => {
        openStore = () => resolve(contractFactorySqliteStore({ path: env.FACTORY_DB }));
      });

      // A pool holds a token as token0 or token1, and a filter names one side, so each side gets its own
      // decoders: Pipes refuses two filters on the same event in one decoder (E0004). A factory learns its
      // pools from every creation log in a batch, whichever decoder asked for it, so the pools created
      // before START_BLOCK are known when its Swaps start.
      const side = (token: "token0" | "token1") => {
        const created = {
          event: factoryEvents[CREATED]!,
          params: { [token]: tokens } as Record<typeof token, string[]>,
        };
        const pools = contractFactory({
          address: factory.address,
          event: created,
          childAddressField: CHILD_ADDRESS,
          database,
        });
        return {
          created: evmEventDecoder({
            range: { from: env.POOLS_START_BLOCK, to },
            contracts: [factory.address],
            events: { logs: created },
          }).pipe(({ logs }) => logs.map((log) => ({ event: CREATED, log }))),
          children: evmEventDecoder({
            range: { from: env.START_BLOCK, to },
            contracts: pools,
            events: { logs: childEvents[CHILD_EVENT]! },
          }).pipe(({ logs }) => logs.map((log) => ({ event: CHILD_EVENT, log }))),
        };
      };
      const [token0, token1] = [side("token0"), side("token1")];

      return evmPortalStream({
        id: `${this.name}_${this.table}`,
        portal,
        logger: logger.child({ source: this.name, table: this.table }),
        outputs: {
          // The decoders ask Portal for each log's transaction; this output reads them.
          transactions: evmQuery().addFields({
            block: { number: true },
            transaction: { hash: true, from: true },
          }),
          created0: token0.created,
          children0: token0.children,
          created1: token1.created,
          children1: token1.children,
        },
      }).pipe({
        start({ state }) {
          if (state.current && storeIsNew) {
            throw new Error(
              `${env.FACTORY_DB} is new, but the cursor is at block ${state.current.number}: the pools created ` +
                "before the cursor are gone, so their Swaps would be missed. Reset the source and load it again.",
            );
          }
          openStore();
        },
        transform({ transactions, ...outputs }) {
          const logs = Object.values(outputs).flat();
          // Portal also sends the transactions of the logs the decoders dropped, such as other pools' Swaps.
          const written = new Set(
            logs.map(({ log }) => log.rawEvent.transactionHash),
          );
          return [
            ...logs.map(({ event, log }) => logRecord(event, log)),
            ...transactions.flatMap((block) =>
              block.transactions
                .filter((tx) => written.has(tx.hash))
                .map((tx) => transactionRecord(block.header.number, tx)),
            ),
          ];
        },
      });
    },
  };
};
