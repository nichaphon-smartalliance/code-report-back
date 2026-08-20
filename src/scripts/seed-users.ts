/**
 * Install-time account seeding (TASK-001 §5, SPEC-001 "Data Model")
 * — `bun run seed:users`.
 *
 * This is OPERATIONS, not a feature. It is never mounted on the HTTP app, and
 * REQ-001 §10.2/§10.3 forbid any equivalent endpoint or screen.
 *
 * Input: a JSON file at SEED_USERS_FILE containing
 *   [{ "username": "...", "displayName": "...", "password": "..." }]
 *
 * Passwords are hashed with argon2id and upserted on `username`, so re-running
 * the script updates the existing accounts instead of duplicating them.
 * Only usernames are printed — never a password, never a hash.
 */

import { loadConfigOrExit } from "../config.ts";
import { closePool, query } from "../db/index.ts";

export type SeedUser = {
  username: string;
  displayName: string;
  password: string;
};

export function parseSeedUsers(raw: string): SeedUser[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("seed file is not valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new Error('seed file must be a JSON array of { username, displayName, password }');
  }
  return parsed.map((entry, index) => {
    const position = `entry #${index + 1}`;
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`${position} is not an object`);
    }
    const { username, displayName, password } = entry as Record<
      string,
      unknown
    >;
    if (typeof username !== "string" || username.trim() === "") {
      throw new Error(`${position} has no "username"`);
    }
    if (typeof displayName !== "string" || displayName.trim() === "") {
      throw new Error(`${position} ("${username}") has no "displayName"`);
    }
    if (typeof password !== "string" || password === "") {
      throw new Error(`${position} ("${username}") has no "password"`);
    }
    return { username: username.trim(), displayName: displayName.trim(), password };
  });
}

async function seed(): Promise<void> {
  const config = loadConfigOrExit();
  if (config.SEED_USERS_FILE === undefined) {
    console.error(
      "[seed:users] SEED_USERS_FILE is not set — point it at the JSON file " +
        "holding the accounts to create. See .env.example.",
    );
    process.exit(1);
  }

  const file = Bun.file(config.SEED_USERS_FILE);
  if (!(await file.exists())) {
    console.error(`[seed:users] file not found: ${config.SEED_USERS_FILE}`);
    process.exit(1);
  }

  const users = parseSeedUsers(await file.text());
  if (users.length === 0) {
    console.log("[seed:users] seed file is empty — nothing to do");
    return;
  }

  for (const user of users) {
    const passwordHash = await Bun.password.hash(user.password, {
      algorithm: "argon2id",
    });
    const rows = await query<{ inserted: boolean }>(
      `INSERT INTO users (username, password_hash, display_name)
            VALUES ($1, $2, $3)
       ON CONFLICT (username) DO UPDATE
               SET password_hash = EXCLUDED.password_hash,
                   display_name  = EXCLUDED.display_name
         RETURNING (xmax = 0) AS inserted`,
      [user.username, passwordHash, user.displayName],
    );
    const action = rows[0]?.inserted === true ? "created" : "updated";
    console.log(`[seed:users] ${action} ${user.username}`);
  }

  console.log(`[seed:users] done — ${users.length} account(s) processed`);
}

if (import.meta.main) {
  try {
    await seed();
  } catch (error) {
    console.error(`[seed:users] failed: ${(error as Error).message}`);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
