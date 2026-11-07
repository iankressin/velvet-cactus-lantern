import { readFile } from "node:fs/promises";
import type { TestContext } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
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
      drizzle: () => drizzle(asNodePg(db)),
      close: async () => {},
    }),
  });
  return { db, warehouse };
}

/**
 * PGlite, answering the way a node-postgres client does, for Drizzle and Pipes' Postgres target
 * behind it. node-postgres sends a query without parameters as a simple query, which may hold
 * several statements, and Pipes relies on that; PGlite's `query` takes one statement, its `exec` several.
 */
function asNodePg(db: PGlite) {
  const client = {
    async query(q: string | { text: string; rowMode?: "array" }, params: unknown[] = []) {
      const text = typeof q === "string" ? q : q.text;
      const options = { rowMode: typeof q === "string" ? undefined : q.rowMode };
      const result = params.length ? await db.query(text, params, options) : (await db.exec(text, options)).at(-1);
      return { rows: result?.rows ?? [], rowCount: result?.affectedRows ?? 0, fields: result?.fields ?? [] };
    },
  };
  return client as unknown as pg.Client;
}
