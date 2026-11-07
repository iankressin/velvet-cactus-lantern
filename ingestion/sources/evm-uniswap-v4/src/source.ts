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
  contractFactorySqliteStore,
  defineAbi,
  evmEventDecoder,
  evmPortalStream,
  evmQuery,
  type DecodedEvent,
  type JsonAbiItem,
} from "@subsquid/pipes/evm";
import * as z from "zod";
import poolManagerAbi from "../../../../catalog/protocols/uniswap/abis/v4-pool-manager.json" with { type: "json" };

// Each chain's PoolManager and the block it was deployed in. A folder in chains/ needs its chain here.
// The contract system, from catalog/protocols/uniswap/protocol.yaml. v4 has no pool contracts: the
// PoolManager creates each pool with Initialize and emits every pool's Swap, naming the pool by its id.
const POOL_MANAGERS: Record<string, { address: string; deployedBlock: number }> = {
  ethereum: { address: "0x000000000004444c5dc75cb358380d2e3de08a90", deployedBlock: 21688329 },
};
const CREATED = "Initialize";
const CHILD_EVENT = "Swap";
// The catalog's ABI files are JSON, so their events are typed by name only.
const events = defineAbi(poolManagerAbi as readonly JsonAbiItem[]).events;

const envFor = (chain: string, deployedBlock: number) =>
  z
    .object({
      // The chain's Portal dataset, set in chains/<chain>/.env.example.
      PORTAL_URL: z.url(),
      // Sent with every Portal request when set. Without one, the public Portal answers at its anonymous limits.
      PORTAL_API_KEY: z.string().optional(),
      // The first block of pool creations. A pool created before START_BLOCK still trades after it.
      POOLS_START_BLOCK: z.coerce.number().int().nonnegative().default(deployedBlock),
      // The first block of Swaps. Later runs resume after the cursor Pipes keeps in the warehouse.
      START_BLOCK: z.coerce.number().int().nonnegative(),
      // The last block to read, set only to check a short window. Unset, each run ends at Portal's finalized head.
      END_BLOCK: z.coerce.number().int().positive().optional(),
      // Where the ids of the pools found so far are kept, relative to the package. Each chain has its own.
      FACTORY_DB: z.string().min(1).default(`chains/${chain}/factory.sqlite`),
    })
    .refine((e) => e.POOLS_START_BLOCK <= e.START_BLOCK, {
      message: "POOLS_START_BLOCK must not be after START_BLOCK, or the Swaps of pools created between them are lost",
    });

export type PoolManagerSourceEnv = z.infer<ReturnType<typeof envFor>>;

type Log = DecodedEvent<Record<string, unknown>>;

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

function transactionRecord(blockNumber: number, tx: { hash: string; from: string }): RawRecord {
  const id = `tx:${tx.hash}`;
  return { id, callId: id, data: { kind: "transaction", block_number: blockNumber, hash: tx.hash, from: tx.from } };
}

/** A chain name as SOURCES and the dbt sources spell it, such as `ethereum`. */
export const chainName = z.string().regex(/^[a-z][a-z0-9]*$/, "Expected a chain name such as ethereum");

// Uniswap v4 logs of the tokens in chains/<chain>/addresses.json, each as emitted: every Initialize
// naming a token, from POOLS_START_BLOCK, and every Swap of those pools, from START_BLOCK. Also the
// transactions those logs came from, as records of their own. The source is named for its chain, so
// each chain loads into raw.<chain>_uniswap_v4.
//
// Pipes' factory pattern follows child contracts by address, and every v4 Swap comes from the one
// PoolManager, so this source does by pool id what the pattern does by address: it asks Portal for every
// PoolManager Swap and keeps those of the pools it has seen created, whose ids it keeps in Pipes' factory
// store. Asking Portal for the token's pool ids in the id topic instead was about six times slower over
// the same 5,000 blocks, and had not finished after eight minutes through Pipes.
export const forChain = (chain: string): StreamSource<PoolManagerSourceEnv> => {
  const poolManager = POOL_MANAGERS[chainName.parse(chain)];
  if (!poolManager) {
    throw new Error(`No Uniswap v4 pool manager on ${chain}: add it to POOL_MANAGERS from catalog/protocols/uniswap/protocol.yaml`);
  }
  return {
    name: chain,
    table: "uniswap_v4",
    env: envFor(chain, poolManager.deployedBlock),
    async stream(env) {
      // Read inside the run, not at import, so runSource reports a bad addresses.json.
      const addresses = readJson(`chains/${chain}/addresses.json`);
      const tokens = validateEthAddressList(addresses.tokens).map((a) => a.toLowerCase());
      const portal = portalClient(env.PORTAL_URL, env.PORTAL_API_KEY);
      const to = Math.min(env.END_BLOCK ?? Infinity, await finalizedHead(portal));
      const storeIsNew = !existsSync(env.FACTORY_DB);
      // Opened, and so created, only once the check in `start` below passes. A run that check stops leaves
      // no new file for the next run to trust.
      let store: Awaited<ReturnType<typeof contractFactorySqliteStore>>;
      const pools = new Set<string>();

      // A pool holds a token as currency0 or currency1, and a filter names one side, so each side gets its
      // own decoder: Pipes refuses two filters on the same event in one decoder (E0004).
      const created = (currency: "currency0" | "currency1") =>
        evmEventDecoder({
          range: { from: env.POOLS_START_BLOCK, to },
          contracts: [poolManager.address],
          events: { logs: { event: events[CREATED]!, params: { [currency]: tokens } as Record<typeof currency, string[]> } },
        }).pipe(({ logs }) => logs);

      return evmPortalStream({
        id: `${this.name}_${this.table}`,
        portal,
        logger: logger.child({ source: this.name, table: this.table }),
        outputs: {
          // The decoders ask Portal for each log's transaction; this output reads them.
          transactions: evmQuery().addFields({ block: { number: true }, transaction: { hash: true, from: true } }),
          created0: created("currency0"),
          created1: created("currency1"),
          swaps: evmEventDecoder({
            range: { from: env.START_BLOCK, to },
            contracts: [poolManager.address],
            events: { logs: events[CHILD_EVENT]! },
          }).pipe(({ logs }) => logs),
        },
      }).pipe({
        async start({ state }) {
          if (state.current && storeIsNew) {
            throw new Error(
              `${env.FACTORY_DB} is new, but the cursor is at block ${state.current.number}: the pools created ` +
                "before the cursor are gone, so their Swaps would be missed. Reset the source and load it again.",
            );
          }
          store = await contractFactorySqliteStore({ path: env.FACTORY_DB });
          await store.migrate();
          // Only the pools of the tokens in addresses.json now, as the v2 and v3 factories check each lookup.
          for (const currency of ["currency0", "currency1"]) {
            for (const pool of await store.all({ [currency]: tokens })) pools.add(pool.childAddress);
          }
        },
        async transform({ transactions, created0, created1, swaps }) {
          const created = [...created0, ...created1];
          if (created.length > 0) await store.save(
            created.map((log) => ({
              childAddress: String(log.event.id),
              factoryAddress: log.contract,
              blockNumber: log.block.number,
              transactionIndex: log.rawEvent.transactionIndex,
              logIndex: log.rawEvent.logIndex,
              event: log.event,
            })),
          );
          for (const log of created) pools.add(String(log.event.id));
          const kept = swaps.filter((log) => pools.has(String(log.event.id)));
          // Portal also sends the transactions of the Swaps dropped here, those of other pools.
          const written = new Set([...created, ...kept].map((log) => log.rawEvent.transactionHash));
          return [
            ...created.map((log) => logRecord(CREATED, log)),
            ...kept.map((log) => logRecord(CHILD_EVENT, log)),
            ...transactions.flatMap((block) =>
              block.transactions.filter((tx) => written.has(tx.hash)).map((tx) => transactionRecord(block.header.number, tx)),
            ),
          ];
        },
      });
    },
  };
};
