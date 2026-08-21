/**
 * HTTP app + server bootstrap (TASK-001 §1, §6).
 *
 * `GET /api/health`, the three auth routes, the two report routes and the two
 * repository-inspection routes (TASK-017). The session gate in front of
 * `/api/reports*` was mounted by TASK-002, before those routes existed, so they
 * are protected by construction rather than by someone remembering; the
 * `/api/repos*` gate is mounted the same way, for the same reason.
 */

import { Hono } from "hono";
import { requireSession, type SessionEnv } from "./auth/middleware.ts";
import { createAuthRoutes } from "./auth/routes.ts";
import { describeConfig, loadConfigOrExit } from "./config.ts";
import { errorEnvelope, requestLanguage } from "./errors/index.ts";
import { sweepStaleTempDirs } from "./git/cleanup.ts";
import { createReportRoutes } from "./reports/routes.ts";
import { createRepoRoutes } from "./repos/routes.ts";

export const app = new Hono<SessionEnv>();

// The only unauthenticated route besides login (TASK-001 §6).
app.get("/api/health", (c) => c.json({ status: "ok" }));

// Session gate — every /api/reports route, before any of them exist (TASK-002 §5).
app.use("/api/reports", requireSession);
app.use("/api/reports/*", requireSession);

// Session gate — every /api/repos route, mounted before them for the same
// reason (TASK-017 §4): an unauthenticated call is 401 and no git process runs.
app.use("/api/repos", requireSession);
app.use("/api/repos/*", requireSession);

app.route("/api/auth", createAuthRoutes());
app.route("/api/reports", createReportRoutes());
app.route("/api/repos", createRepoRoutes());

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
  // Clones left behind by a crash are a data leak, so the sweep runs before
  // the first request can create a new one (SPEC-001 "Limits", TASK-005 §2).
  const swept = await sweepStaleTempDirs();
  console.log(
    JSON.stringify({ level: "info", msg: "temp-sweep", removed: swept.length }),
  );
  Bun.serve({ port: config.PORT, fetch: app.fetch });
}
