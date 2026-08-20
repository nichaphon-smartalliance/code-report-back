/**
 * The session (TASK-002 §4, SPEC-001 "API → Auth").
 *
 * Session = a JWT in the `cr_session` cookie. HttpOnly, SameSite=Lax, Secure in
 * production, Path=/, 12-hour expiry, signed with SESSION_SECRET.
 *
 * The payload carries `sub`, `iat`, `exp` and NOTHING else — no role, no
 * permission, no display name. REQ-001 §10.1: all users are identical, so a
 * claim that could differentiate them must not exist in the first place.
 *
 * There is no refresh token and no remember-me: expiry returns the user to the
 * login screen, which is the whole of the requested behaviour.
 */

import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { sign, verify } from "hono/jwt";
import { loadConfigOrExit } from "../config.ts";

export const SESSION_COOKIE = "cr_session";

/**
 * Pinned on both sides. Verifying with a fixed algorithm rather than the one
 * the token's own header asks for is what stops an `alg`-confusion forgery.
 */
const SESSION_ALG = "HS256";

/** 12 hours, in seconds (TASK-002 §4). */
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

export type SessionPayload = {
  sub: string;
  iat: number;
  exp: number;
};

function sessionSecret(): string {
  return loadConfigOrExit().SESSION_SECRET;
}

/**
 * `Secure` is set outside development. It cannot be unconditional: a browser
 * drops a `Secure` cookie sent over plain http, which would make local
 * development silently unable to log in.
 */
function secureCookie(): boolean {
  return process.env.NODE_ENV === "production";
}

/** Sign a session token for `userId`. `now` is injectable for tests only. */
export async function signSession(
  userId: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const payload: SessionPayload = {
    sub: userId,
    iat: now,
    exp: now + SESSION_TTL_SECONDS,
  };
  return sign(payload, sessionSecret(), SESSION_ALG);
}

/**
 * The user id carried by a valid, unexpired, untampered token — or `undefined`
 * for every other case. Callers cannot tell the failure modes apart, and must
 * not: missing, expired and forged all answer AUTH_REQUIRED.
 */
export async function verifySession(
  token: string,
): Promise<string | undefined> {
  try {
    const payload = (await verify(token, sessionSecret(), SESSION_ALG)) as SessionPayload;
    return typeof payload.sub === "string" && payload.sub !== ""
      ? payload.sub
      : undefined;
  } catch {
    return undefined;
  }
}

/** The user id of the request's session, if it has a usable one. */
export async function sessionUserId(c: Context): Promise<string | undefined> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token === undefined || token === "") return undefined;
  return verifySession(token);
}

export async function setSessionCookie(
  c: Context,
  userId: string,
): Promise<void> {
  setCookie(c, SESSION_COOKIE, await signSession(userId), {
    httpOnly: true,
    sameSite: "Lax",
    secure: secureCookie(),
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, {
    httpOnly: true,
    sameSite: "Lax",
    secure: secureCookie(),
    path: "/",
  });
}
