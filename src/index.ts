/**
 * HTTP app + server bootstrap (TASK-001 §1, §6).
 *
 * `GET /api/health` and the three auth routes exist at this point. The git
 * layer (TASK-003), the AI pipeline (TASK-004) and the report endpoints
 * (TASK-005) mount onto this app later — the session gate in front of
 * `/api/reports*` is already here, so those routes are protected the moment
 * they are added.
 */

import { Hono } from "hono";
import { requireSession, type SessionEnv } from "./auth/middleware.ts";
import { createAuthRoutes } from "./auth/routes.ts";
import { describeConfig, loadConfigOrExit } from "./config.ts";
import { errorEnvelope, requestLanguage } from "./errors/index.ts";

export const app = new Hono<SessionEnv>();

// The only unauthenticated route besides login (TASK-001 §6).
app.get("/api/health", (c) => c.json({ status: "ok" }));

// Session gate — every /api/reports route, before any of them exist (TASK-002 §5).
app.use("/api/reports", requireSession);
app.use("/api/reports/*", requireSession);

app.route("/api/auth", createAuthRoutes());

app.onError((error, c) => {
  console.error(
    JSON.stringify({ level: "error", msg: "unhandled", error: String(error) }),
  );
  return c.json(errorEnvelope("INTERNAL", requestLanguage(c)), 500);
});

if (import.meta.main) {
  const config = loadConfigOrExit();
  console.log(
    JSON.stringify({ level: "info", msg: "starting", ...describeConfig(config) }),
  );
  Bun.serve({ port: config.PORT, fetch: app.fetch });
}
