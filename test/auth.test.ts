/**
 * TASK-002 — auth endpoints, session cookie and the `/api/reports*` gate.
 *
 * No database: the routes take a `UserRepository`, and these tests hand them an
 * in-memory one holding real argon2id hashes. The DB-backed repository is a
 * pair of parameterised SELECTs exercised for real in TASK-009.
 */

process.env.DATABASE_URL ??= "postgres://user:pw@127.0.0.1:5432/code_report_test";
process.env.SESSION_SECRET ??= "test-session-secret-not-a-real-one";

import { beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { requireSession, type SessionEnv } from "../src/auth/middleware.ts";
import { createAuthRoutes } from "../src/auth/routes.ts";
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  signSession,
} from "../src/auth/session.ts";
import type { PublicUser, UserRepository, UserWithHash } from "../src/auth/users.ts";

const USER_ID = "11111111-2222-3333-4444-555555555555";
const USERNAME = "somchai";
const PASSWORD = "correct-horse-battery-staple";

let stored: UserWithHash;

const users: UserRepository = {
  async findByUsername(username: string): Promise<UserWithHash | undefined> {
    return username === stored.username ? stored : undefined;
  },
  async findById(id: string): Promise<PublicUser | undefined> {
    if (id !== stored.id) return undefined;
    const { passwordHash: _hash, ...rest } = stored;
    return rest;
  },
};

const app = new Hono().route("/api/auth", createAuthRoutes(users));

beforeAll(async () => {
  stored = {
    id: USER_ID,
    username: USERNAME,
    displayName: "สมชาย ใจดี",
    passwordHash: await Bun.password.hash(PASSWORD, { algorithm: "argon2id" }),
  };
});

function login(body: unknown, headers: Record<string, string> = {}) {
  return app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function loginCookie(): Promise<string> {
  const response = await login({ username: USERNAME, password: PASSWORD });
  const setCookie = response.headers.get("Set-Cookie") ?? "";
  return setCookie.split(";")[0] ?? "";
}

describe("POST /api/auth/login", () => {
  test("valid credentials return the user and set an HttpOnly session cookie", async () => {
    const response = await login({ username: USERNAME, password: PASSWORD });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      user: { id: USER_ID, username: USERNAME, displayName: "สมชาย ใจดี" },
    });

    const setCookie = response.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toStartWith(`${SESSION_COOKIE}=`);
    expect(setCookie).toContain("HttpOnly");
  });

  test("the response body carries no password and no hash", async () => {
    const response = await login({ username: USERNAME, password: PASSWORD });
    const body = await response.text();
    expect(body).not.toContain(PASSWORD);
    expect(body).not.toContain("argon2");
    expect(body).not.toContain("passwordHash");
  });

  test("cookie flags: HttpOnly, SameSite=Lax, Path=/, 12-hour expiry", async () => {
    const setCookie =
      (await login({ username: USERNAME, password: PASSWORD })).headers.get(
        "Set-Cookie",
      ) ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain(`Max-Age=${SESSION_TTL_SECONDS}`);
    expect(SESSION_TTL_SECONDS).toBe(12 * 60 * 60);
  });

  test("wrong password → 401 INVALID_CREDENTIALS", async () => {
    const response = await login({ username: USERNAME, password: "wrong" });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "INVALID_CREDENTIALS" },
    });
    expect(response.headers.get("Set-Cookie")).toBeNull();
  });

  test("unknown username → the identical status, code and message", async () => {
    const unknown = await login({ username: "nobody", password: "wrong" });
    const wrongPassword = await login({ username: USERNAME, password: "wrong" });
    expect(unknown.status).toBe(wrongPassword.status);
    expect(await unknown.text()).toBe(await wrongPassword.text());
  });

  test("both failures answer in th and in en, from the same message table", async () => {
    const th = await login({ username: "nobody", password: "x" });
    const en = await login(
      { username: "nobody", password: "x" },
      { "Accept-Language": "en" },
    );
    const thBody = (await th.json()) as { error: { message: string } };
    const enBody = (await en.json()) as { error: { message: string } };
    expect(thBody.error.message).not.toBe(enBody.error.message);
  });

  test("a malformed body is an invalid credential, not a 500", async () => {
    const response = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "INVALID_CREDENTIALS" },
    });
  });
});

describe("GET /api/auth/me", () => {
  test("with a fresh cookie → 200 and the user", async () => {
    const cookie = await loginCookie();
    const response = await app.request("/api/auth/me", { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      user: { id: USER_ID, username: USERNAME, displayName: "สมชาย ใจดี" },
    });
  });

  test("without a cookie → 401 AUTH_REQUIRED", async () => {
    const response = await app.request("/api/auth/me");
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "AUTH_REQUIRED" },
    });
  });

  test("with an expired token → 401 AUTH_REQUIRED", async () => {
    const issuedAt = Math.floor(Date.now() / 1000) - SESSION_TTL_SECONDS - 60;
    const expired = await signSession(USER_ID, issuedAt);
    const response = await app.request("/api/auth/me", {
      headers: { cookie: `${SESSION_COOKIE}=${expired}` },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "AUTH_REQUIRED" },
    });
  });

  test("with a tampered token → 401 AUTH_REQUIRED", async () => {
    const cookie = await loginCookie();
    const tampered = `${cookie.slice(0, -1)}${cookie.endsWith("A") ? "B" : "A"}`;
    const response = await app.request("/api/auth/me", {
      headers: { cookie: tampered },
    });
    expect(response.status).toBe(401);
  });
});

describe("POST /api/auth/logout", () => {
  test("returns 204 and clears the cookie", async () => {
    const cookie = await loginCookie();
    const response = await app.request("/api/auth/logout", {
      method: "POST",
      headers: { cookie },
    });
    expect(response.status).toBe(204);

    const setCookie = response.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain(`${SESSION_COOKIE}=;`);
    expect(setCookie).toContain("Max-Age=0");
  });
});

describe("requireSession", () => {
  test("rejects an unauthenticated call without executing the handler", async () => {
    let handlerRan = false;
    const guarded = new Hono<SessionEnv>();
    guarded.use("/api/reports/*", requireSession);
    guarded.get("/api/reports/anything", (c) => {
      handlerRan = true;
      return c.json({ ok: true });
    });

    const response = await guarded.request("/api/reports/anything");
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "AUTH_REQUIRED" },
    });
    expect(handlerRan).toBe(false);
  });

  test("passes the user id through to the handler when the session is valid", async () => {
    const guarded = new Hono<SessionEnv>();
    guarded.use("/api/reports/*", requireSession);
    guarded.get("/api/reports/anything", (c) => c.json({ userId: c.get("userId") }));

    const response = await guarded.request("/api/reports/anything", {
      headers: { cookie: `${SESSION_COOKIE}=${await signSession(USER_ID)}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: USER_ID });
  });
});

describe("the real app", () => {
  test("gates /api/reports even before TASK-005 adds the routes", async () => {
    const { app: realApp } = await import("../src/index.ts");
    for (const path of ["/api/reports", "/api/reports/some-job-id"]) {
      const response = await realApp.request(path);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        error: { code: "AUTH_REQUIRED" },
      });
    }
  });

  test("mounts exactly the three auth routes and no account-management route", async () => {
    const { app: realApp } = await import("../src/index.ts");
    for (const path of [
      "/api/auth/register",
      "/api/auth/signup",
      "/api/auth/change-password",
      "/api/auth/forgot-password",
      "/api/auth/reset-password",
      "/api/users",
    ]) {
      const response = await realApp.request(path, { method: "POST" });
      expect(response.status).toBe(404);
    }
  });
});
