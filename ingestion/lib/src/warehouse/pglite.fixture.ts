import { readFile } from "node:fs/promises";
import type { TestContext } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { postgresWarehouse } from "#src/warehouse/index.ts";

const opsSql = new URL("../../../../infra/postgres/ops.sql", import.meta.url);

/** A warehouse in a fresh in-process Postgres, with the ops schema the real one gets from ops.sql. */
export async function pgliteWarehouse(t: TestContext) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(await readFile(opsSql, "utf8"));
  const warehouse = postgresWarehouse({
    schema: "raw",
    connect: async () => ({
      query: <R>(text: string, params?: unknown[]) => db.query<R>(text, params),
      close: async () => {},
    }),
  });
  return { db, warehouse };
}
