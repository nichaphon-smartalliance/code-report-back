/**
 * The three auth endpoints — and only these three (TASK-002 §1–§3,
 * SPEC-001 "API → Auth").
 *
 *   POST /api/auth/login   → 200 { user } + Set-Cookie | 401 INVALID_CREDENTIALS
 *   POST /api/auth/logout  → 204
 *   GET  /api/auth/me      → 200 { user } | 401 AUTH_REQUIRED
 *
 * There is no register, no user CRUD, no change-password, no forgot-password
 * and no reset-token route. Adding one is a spec violation (REQ-001 §10.2–§10.4).
 */

import { Hono } from "hono";
import { errorEnvelope, requestLanguage } from "../errors/index.ts";
import { clearSessionCookie, sessionUserId, setSessionCookie } from "./session.ts";
import { dbUserRepository, publicUser, type UserRepository } from "./users.ts";

/**
 * An argon2id hash of a fixed throwaway string, verified against whenever the
 * username does not exist. Without it, "no such user" would answer in a
 * fraction of the time "wrong password" takes and the login endpoint would
 * become a username oracle. SPEC-001: identical message, identical timing path.
 */
const ABSENT_USER_HASH =
  "$argon2id$v=19$m=65536,t=2,p=1$onm9RYI6fjdFKZVj+ayOiA8XlUGRyjEfLh49WhZUrsU$wfW2PHDtDaM4WmtGQBoQG3HbpnTt2nJWACaaM/UbQI4";

type LoginBody = { username: string; password: string };

function readLoginBody(body: unknown): LoginBody | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { username, password } = body as Record<string, unknown>;
  if (typeof username !== "string" || typeof password !== "string") {
    return undefined;
  }
  return { username, password };
}

export function createAuthRoutes(
  users: UserRepository = dbUserRepository,
): Hono {
  const auth = new Hono();

  auth.post("/login", async (c) => {
    const invalid = () =>
      c.json(errorEnvelope("INVALID_CREDENTIALS", requestLanguage(c)), 401);

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return invalid();
    }
    const body = readLoginBody(raw);
    if (body === undefined) return invalid();

    const user = await users.findByUsername(body.username);
    // Always compare — see ABSENT_USER_HASH.
    const matches = await Bun.password.verify(
      body.password,
      user?.passwordHash ?? ABSENT_USER_HASH,
    );
    if (user === undefined || !matches) return invalid();

    await setSessionCookie(c, user.id);
    return c.json({ user: publicUser(user) }, 200);
  });

  auth.post("/logout", (c) => {
    clearSessionCookie(c);
    return c.body(null, 204);
  });

  auth.get("/me", async (c) => {
    const userId = await sessionUserId(c);
    const user =
      userId === undefined ? undefined : await users.findById(userId);
    if (user === undefined) {
      return c.json(errorEnvelope("AUTH_REQUIRED", requestLanguage(c)), 401);
    }
    return c.json({ user: publicUser(user) }, 200);
  });

  return auth;
}
