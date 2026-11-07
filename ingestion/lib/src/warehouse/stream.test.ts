import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { commonAbis, evmEventDecoder, evmPortalStream } from "@subsquid/pipes/evm";
import { PortalClient } from "@subsquid/pipes/portal-client";
import { mockPortal } from "@subsquid/pipes/testing";
import { encodeEvent, mockBlock } from "@subsquid/pipes/testing/evm";
import { erc20Abi } from "viem";
import * as z from "zod";
import { runSource } from "#src/run/index.ts";
import type { StreamSource } from "#src/source.ts";
import { pgliteWarehouse } from "#src/warehouse/pglite.fixture.ts";

process.env.PUSHGATEWAY_URL = "";

const token = "0x00000000000000000000000000000000000000aa";
const wallet = "0x00000000000000000000000000000000000000bb";

/** A local Portal with one Transfer in each of blocks 1 to `last`, two blocks a response. */
async function chain(t: TestContext, last: number) {
  const transfer = encodeEvent({
    abi: erc20Abi,
    eventName: "Transfer",
    address: token,
    args: { from: wallet, to: wallet, value: 1n },
  });
  const blocks = Array.from({ length: last }, (_, i) =>
    mockBlock({ number: i + 1, transactions: [{ logs: [transfer] }] }),
  );
  const portal = await mockPortal({ blocks, blocksPerResponse: 2 });
  t.after(() => portal.close());
  return portal.url;
}

/** Transfers from block 1 to `to`. `broken` gives the record of that block an id Postgres rejects. */
function transfers(url: string, to: number, maxBlocksPerRun: number, broken = () => 0): StreamSource<unknown> {
  return {
    name: "test",
    table: "transfers",
    env: z.object({}),
    maxBlocksPerRun,
    stream: async () =>
      evmPortalStream({
        id: "test",
        // The mock answers at once, so Pipes would merge every response into one batch. A tiny
        // maxBytes cuts a batch after each response, two blocks, like a slower real Portal.
        portal: new PortalClient({ url, finalized: true, maxBytes: 1 }),
        logger: "silent",
        outputs: evmEventDecoder({
          range: { from: 1, to },
          contracts: [token],
          events: { transfers: commonAbis.erc20.events.Transfer },
        }).pipe(({ transfers }) =>
          transfers.map((t) => {
            // Postgres text cannot hold a NUL byte, so this record fails its whole batch.
            const id = t.block.number === broken() ? "bad\u0000" : String(t.block.number);
            return { id, callId: id, data: { block: t.block.number } };
          }),
        ),
      }),
  };
}

const loaded = async (db: PGlite) =>
  (await db.query<{ id: string }>("select id from raw.test_transfers order by id::int")).rows.map((r) => r.id);
const cursor = async (db: PGlite) =>
  (await db.query<{ n: string }>("select max(current_number) as n from raw._sync where id = 'test_transfers'")).rows[0]?.n;

test("each run resumes after the last block the one before loaded, and stops after maxBlocksPerRun", async (t) => {
  const { db, warehouse } = await pgliteWarehouse(t);
  const source = transfers(await chain(t, 6), 6, 3);

  await runSource(source, warehouse);
  assert.deepEqual(await loaded(db), ["1", "2", "3", "4"], "the run stopped on the batch that passed 3 blocks");
  await runSource(source, warehouse);
  assert.deepEqual(await loaded(db), ["1", "2", "3", "4", "5", "6"]);
  await runSource(source, warehouse);

  assert.equal(process.exitCode, undefined, "every run succeeded");
  assert.equal(await cursor(db), "6");
  const { rows } = await db.query<{ records_written: number }>(
    "select records_written from ops.ingestion_runs order by started_at",
  );
  assert.deepEqual(rows.map((r) => r.records_written), [4, 2, 0], "the last run found nothing new");
});

test("a batch that fails to load commits neither its rows nor its block, so the next run reads it again", async (t) => {
  const { db, warehouse } = await pgliteWarehouse(t);
  const url = await chain(t, 4);
  let broken = 3;

  await runSource(transfers(url, 4, 100, () => broken), warehouse);
  assert.equal(process.exitCode, 1, "the run failed");
  process.exitCode = undefined;
  assert.deepEqual(await loaded(db), ["1", "2"]);
  assert.equal(await cursor(db), "2");

  broken = 0;
  await runSource(transfers(url, 4, 100, () => broken), warehouse);
  assert.equal(process.exitCode, undefined);
  assert.deepEqual(await loaded(db), ["1", "2", "3", "4"]);
});
