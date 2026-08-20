/**
 * Migration runner (TASK-001 §4) — `bun run migrate`.
 *
 * Applies every .sql file in ./migrations, in filename order, that is not yet
 * recorded in schema_migrations. Each file runs inside its own transaction
 * together with the bookkeeping row, so a failed migration leaves no trace and
 * a second run is a no-op.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { closePool, query, withTransaction } from "./index.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");

async function ensureBookkeepingTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function appliedFilenames(): Promise<Set<string>> {
  const rows = await query<{ filename: string }>(
    "SELECT filename FROM schema_migrations",
  );
  return new Set(rows.map((row) => row.filename));
}

export async function migrate(): Promise<void> {
  await ensureBookkeepingTable();
  const applied = await appliedFilenames();

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort();

  let count = 0;
  for (const filename of files) {
    if (applied.has(filename)) {
      console.log(`[migrate] skip    ${filename} (already applied)`);
      continue;
    }
    const sql = await Bun.file(join(MIGRATIONS_DIR, filename)).text();
    await withTransaction(async (tx) => {
      await tx.query(sql);
      await tx.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [
        filename,
      ]);
    });
    console.log(`[migrate] applied ${filename}`);
    count += 1;
  }

  console.log(
    count === 0
      ? "[migrate] nothing to do — database is up to date"
      : `[migrate] done — ${count} migration(s) applied`,
  );
}

if (import.meta.main) {
  try {
    await migrate();
  } catch (error) {
    console.error(`[migrate] failed: ${(error as Error).message}`);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
