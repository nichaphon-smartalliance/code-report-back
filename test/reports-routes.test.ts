/**
 * TASK-005 §1, §4, §5 — the two report endpoints.
 *
 * The routes take their dependencies as arguments, so they run against the
 * in-memory job repository and a fake `AiClient` with no database and no
 * network (SPEC-001 "Testing"). The session gate is the real `requireSession`
 * from TASK-002, mounted exactly as `src/index.ts` mounts it.
 */

process.env.DATABASE_URL ??= "postgres://user:pw@127.0.0.1:5432/code_report_test";
process.env.SESSION_SECRET ??= "test-session-secret-not-a-real-one";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { requireSession, type SessionEnv } from "../src/auth/middleware.ts";
import { SESSION_COOKIE, signSession } from "../src/auth/session.ts";
import type { AiClient, ChatResult } from "../src/ai/client.ts";
import type { GitRunner } from "../src/git/run.ts";
import { runGit } from "../src/git/run.ts";
import type { HostLookup } from "../src/git/urlSafety.ts";
import { createReportRoutes } from "../src/reports/routes.ts";
import { createReportWorker, type ReportWorker } from "../src/reports/worker.ts";
import { fakeAiClient } from "./fixtures/aiClient.ts";
import { memoryJobRepository, type MemoryJobRepository } from "./fixtures/jobRepository.ts";
import { commitFiles, initRepo, makeTempDir, removeDir } from "./fixtures/gitRepo.ts";

const REPO_URL = "https://git.example.test/fixture.git";
const DUMMY_PAT = "ghp_TESTTOKEN0123456789abcdef";
const OWNER = "11111111-2222-3333-4444-555555555555";
const OTHER = "99999999-8888-7777-6666-555555555555";

const PUBLIC_LOOKUP: HostLookup = async () => [
  { address: "93.184.216.34", family: 4 },
];

const VALID_BODY = {
  repoUrl: REPO_URL,
  dateFrom: "2026-08-01",
  dateTo: "2026-08-07",
  language: "en",
};

let root: string;
let source: string;

beforeAll(async () => {
  root = await makeTempDir("code-report-routes-");
  source = join(root, "source");
  await mkdir(source, { recursive: true });
  await initRepo(source);
  await commitFiles(source, {
    message: "feat: the scheduling grid",
    date: "2026-08-03T10:00:00+07:00",
    authorName: "Somchai Jaidee",
    authorEmail: "somchai@x.co.th",
    files: { "README.md": "# fixture\n", "src/grid.ts": "export const grid = 1;\n" },
  });
});

afterAll(async () => {
  await removeDir(root);
});

function fixtureRunner(path: string): GitRunner {
  return async (args, options) => {
    if (args.includes("clone")) {
      const rewritten = [...args];
      rewritten[rewritten.length - 2] = path;
      return runGit(rewritten, options);
    }
    return runGit(args, options);
  };
}

type App = {
  jobs: MemoryJobRepository;
  started: { job: string; pat: string | undefined }[];
  request(path: string, init?: RequestInit & { cookie?: string }): Promise<Response>;
};

/** A worker that records what it was handed instead of doing any work. */
function recordingWorker(started: App["started"]): ReportWorker {
  return {
    async enqueue(job, pat) {
      started.push({ job: job.id, pat });
    },
  };
}

function buildApp(worker?: (jobs: MemoryJobRepository) => ReportWorker): App {
  const jobs = memoryJobRepository();
  const started: App["started"] = [];
  const app = new Hono<SessionEnv>();
  app.use("/api/reports", requireSession);
  app.use("/api/reports/*", requireSession);
  app.route(
    "/api/reports",
    createReportRoutes({
      jobs,
      worker: worker === undefined ? recordingWorker(started) : worker(jobs),
    }),
  );

  return {
    jobs,
    started,
    async request(path, init = {}) {
      const { cookie, ...rest } = init;
      const headers = new Headers(rest.headers);
      if (cookie !== undefined) headers.set("Cookie", cookie);
      return app.request(path, { ...rest, headers });
    },
  };
}

/** `response.json()` is `unknown`; every read in this file goes through here. */
async function json<T = Record<string, any>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function cookieFor(userId: string): Promise<string> {
  return `${SESSION_COOKIE}=${await signSession(userId)}`;
}

function post(app: App, body: unknown, cookie?: string) {
  return app.request("/api/reports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...(cookie === undefined ? {} : { cookie }),
  });
}

describe("the session gate (TASK-005 §5)", () => {
  test("an unauthenticated POST is 401 AUTH_REQUIRED and starts no work", async () => {
    const app = buildApp();
    const response = await post(app, VALID_BODY);
    expect(response.status).toBe(401);
    expect((await json(response)).error.code).toBe("AUTH_REQUIRED");
    expect(app.jobs.all()).toHaveLength(0);
    expect(app.started).toHaveLength(0);
  });

  test("an unauthenticated GET is 401 AUTH_REQUIRED", async () => {
    const app = buildApp();
    const response = await app.request("/api/reports/whatever");
    expect(response.status).toBe(401);
    expect((await json(response)).error.code).toBe("AUTH_REQUIRED");
  });
});

describe("POST /api/reports", () => {
  test("a valid body returns 202 { jobId } and hands the worker the PAT", async () => {
    const app = buildApp();
    const response = await post(
      app,
      { ...VALID_BODY, pat: DUMMY_PAT },
      await cookieFor(OWNER),
    );

    expect(response.status).toBe(202);
    const { jobId } = await json(response);
    expect(typeof jobId).toBe("string");

    const stored = app.jobs.get(jobId);
    expect(stored.status).toBe("QUEUED");
    expect(stored.userId).toBe(OWNER);
    // The token reached the worker as an argument…
    expect(app.started).toEqual([{ job: jobId, pat: DUMMY_PAT }]);
    // …and no field of the stored row carries it.
    expect(app.jobs.dump()).not.toContain(DUMMY_PAT);
    expect(Object.keys(stored)).not.toContain("pat");
  });

  test("a repoUrl carrying a credential never reaches jobs.create", async () => {
    const app = buildApp();
    const credentialed = `https://x-access-token:${DUMMY_PAT}@github.com/o/r.git`;
    const response = await app.request("/api/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept-Language": "en" },
      body: JSON.stringify({ ...VALID_BODY, repoUrl: credentialed }),
      cookie: await cookieFor(OWNER),
    });

    expect(response.status).toBe(400);
    const body = await json(response);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(Object.keys(body.error.fields)).toEqual(["repoUrl"]);
    // The assertion that matters: no row exists, no work started, and the
    // secret is nowhere in the store or in what we sent back.
    expect(app.jobs.all()).toHaveLength(0);
    expect(app.started).toHaveLength(0);
    expect(app.jobs.dump()).not.toContain(DUMMY_PAT);
    expect(JSON.stringify(body)).not.toContain(DUMMY_PAT);
  });

  test("a rejected body is 400 VALIDATION_ERROR with a per-field map", async () => {
    const app = buildApp();
    const response = await app.request("/api/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept-Language": "en" },
      body: JSON.stringify({ ...VALID_BODY, dateFrom: "2026-08-07", dateTo: "2026-08-01" }),
      cookie: await cookieFor(OWNER),
    });

    expect(response.status).toBe(400);
    const body = await json(response);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.fields).toEqual({ dateTo: "Must not be before dateFrom." });
    expect(app.jobs.all()).toHaveLength(0);
    expect(app.started).toHaveLength(0);
  });

  test("the field map is in the language the client asked for", async () => {
    const app = buildApp();
    const response = await app.request("/api/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept-Language": "th" },
      body: JSON.stringify({ ...VALID_BODY, language: "fr" }),
      cookie: await cookieFor(OWNER),
    });
    const body = await json(response);
    expect(body.error.fields.language).toBe('ต้องเป็น "th" หรือ "en"');
  });

  test("an unparseable body is a 400, not a 500", async () => {
    const app = buildApp();
    const response = await app.request("/api/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
      cookie: await cookieFor(OWNER),
    });
    expect(response.status).toBe(400);
    expect((await json(response)).error.code).toBe("VALIDATION_ERROR");
  });
});

describe("GET /api/reports/:jobId", () => {
  test("the owner gets the job, and the body has no pat key anywhere", async () => {
    const app = buildApp();
    const cookie = await cookieFor(OWNER);
    const { jobId } = await json(await post(app, { ...VALID_BODY, pat: DUMMY_PAT }, cookie));

    const response = await app.request(`/api/reports/${jobId}`, { cookie });
    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(raw).not.toContain("pat");
    expect(raw).not.toContain(DUMMY_PAT);

    const body = JSON.parse(raw);
    expect(body).toEqual({
      jobId,
      status: "QUEUED",
      stage: null,
      progress: null,
      params: {
        repoUrl: REPO_URL,
        branch: null,
        author: null,
        dateFrom: "2026-08-01",
        dateTo: "2026-08-07",
        language: "en",
      },
      commitCount: null,
      report: null,
      error: null,
    });
  });

  test("another user's job is 404, not 403", async () => {
    const app = buildApp();
    const { jobId } = await json(await post(app, VALID_BODY, await cookieFor(OWNER)));

    const response = await app.request(`/api/reports/${jobId}`, {
      cookie: await cookieFor(OTHER),
    });
    expect(response.status).toBe(404);
  });

  test("an unknown id is 404", async () => {
    const app = buildApp();
    const response = await app.request("/api/reports/does-not-exist", {
      cookie: await cookieFor(OWNER),
    });
    expect(response.status).toBe(404);
  });
});

describe("progress on the wire, from a real run through the worker", () => {
  test("total is 6 and current is the stage's index, at two different stages", async () => {
    let releaseClone: () => void = () => {};
    let releaseAi: () => void = () => {};
    const cloneGate = new Promise<void>((resolve) => (releaseClone = resolve));
    const aiGate = new Promise<void>((resolve) => (releaseAi = resolve));

    const gatedAi: AiClient = {
      async chat(request): Promise<ChatResult> {
        if (request.stage === "AI_PROJECT") await aiGate;
        return fakeAiClient().chat(request);
      },
    };

    const app = buildApp((jobs) =>
      createReportWorker({
        jobs,
        createAiClient: () => gatedAi,
        allowPrivateHosts: false,
        timeZone: "Asia/Bangkok",
        maxConcurrent: 2,
        log: () => {},
        gitRunner: async (args, options) => {
          if (args.includes("clone")) await cloneGate;
          return fixtureRunner(source)(args, options);
        },
        lookup: PUBLIC_LOOKUP,
      }),
    );

    const cookie = await cookieFor(OWNER);
    const { jobId } = await json(await post(app, VALID_BODY, cookie));

    const read = async () =>
      json<{
        stage: string | null;
        progress: { current: number; total: number } | null;
      }>(await app.request(`/api/reports/${jobId}`, { cookie }));

    /** Poll the endpoint the way the frontend does, until `stage` matches. */
    const until = async (stage: string | null) => {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const body = await read();
        if (body.stage === stage) return body;
        await Bun.sleep(20);
      }
      throw new Error(`stage never reached ${stage}`);
    };

    const cloning = await until("CLONING");
    expect(cloning.progress).toEqual({ current: 1, total: 6 });

    releaseClone();
    const analysing = await until("AI_PROJECT");
    expect(analysing.progress).toEqual({ current: 4, total: 6 });

    releaseAi();
    const finished = await until(null);
    expect(finished.progress).toBeNull();
  }, 60_000);
});
