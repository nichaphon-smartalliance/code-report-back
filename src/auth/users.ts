/**
 * User lookup for authentication (TASK-002 §1, §3).
 *
 * Read-only, two queries, no writes: accounts are created by the operations
 * seed script only (TASK-001 §5, REQ-001 §10.2/§10.3). There is deliberately no
 * create/update/delete here — the absence is the requirement.
 *
 * The lookups live behind a `UserRepository` type so the auth routes can be
 * exercised without a database; the default implementation is the real one.
 */

import { query } from "../db/index.ts";

/** What the API returns about a user. There is no role field, by requirement. */
export type PublicUser = {
  id: string;
  username: string;
  displayName: string;
};

export type UserWithHash = PublicUser & {
  passwordHash: string;
};

export type UserRepository = {
  findByUsername(username: string): Promise<UserWithHash | undefined>;
  findById(id: string): Promise<PublicUser | undefined>;
};

type UserRow = {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
};

export const dbUserRepository: UserRepository = {
  async findByUsername(username: string): Promise<UserWithHash | undefined> {
    const rows = await query<UserRow>(
      `SELECT id, username, display_name, password_hash
         FROM users
        WHERE username = $1`,
      [username],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      passwordHash: row.password_hash,
    };
  },

  async findById(id: string): Promise<PublicUser | undefined> {
    const rows = await query<Omit<UserRow, "password_hash">>(
      `SELECT id, username, display_name
         FROM users
        WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    return { id: row.id, username: row.username, displayName: row.display_name };
  },
};

/** The shape sent to the client — never the hash. */
export function publicUser(user: PublicUser): PublicUser {
  return { id: user.id, username: user.username, displayName: user.displayName };
}
