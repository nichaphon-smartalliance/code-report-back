/**
 * Thin query layer over PostgreSQL (TASK-001 §3).
 *
 * Deliberately not an ORM. Two rules hold everywhere in this backend:
 *   1. every value goes in as a bound parameter (`$1`, `$2`, …);
 *   2. no SQL string is ever built by concatenating user input.
 */

import pg from "pg";
import { loadConfigOrExit } from "../config.ts";

let pool: pg.Pool | undefined;

/** Lazily created so that importing this module never opens a connection. */
export function getPool(): pg.Pool {
  if (pool === undefined) {
    pool = new pg.Pool({ connectionString: loadConfigOrExit().DATABASE_URL });
  }
  return pool;
}

export async function query<T extends pg.QueryResultRow>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query<T>(sql, params as unknown[]);
  return result.rows;
}

export type Queryable = {
  query<T extends pg.QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<T[]>;
};

/**
 * Run `fn` inside a transaction on a single dedicated connection.
 * Commits on return, rolls back on throw.
 */
export async function withTransaction<T>(
  fn: (tx: Queryable) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  const tx: Queryable = {
    async query<R extends pg.QueryResultRow>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<R[]> {
      const result = await client.query<R>(sql, params as unknown[]);
      return result.rows;
    },
  };
  try {
    await client.query("BEGIN");
    const value = await fn(tx);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool !== undefined) {
    await pool.end();
    pool = undefined;
  }
}
