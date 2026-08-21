/**
 * TASK-017 §2, §3, §4 — the two repository-inspection endpoints.
 *
 * The routes take their dependencies as arguments, so they run against the
 * git layer's own `runner` seam with **no database, no network and no real
 * remote** (SPEC-001 "Testing"). The session gate is the real `requireSession`
 * from TASK-002, mounted exactly as `src/index.ts` mounts it.
 *
 * The one end-to-end committers test clones a **local fixture repository**
 * through the same seam the report routes' tests use — that is what proves the
 * grouping counts the commits `--no-merges` would let a report find.
 */

process.env.DATABASE_URL ??= "postgres://user:pw@127.0.0.1:5432/code_report_test";
process.env.SESSION_SECRET ??= "test-session-secret-not-a-real-one";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { requireSession, type SessionEnv } from "../src/auth/middleware.ts";
import { SESSION_COOKIE, signSession } from "../src/auth/session.ts";
import { authorizationHeader } from "../src/git/clone.ts";
import { tempRoot } from "../src/git/cleanup.ts";
import type { GitRun, GitRunner } from "../src/git/run.ts";
import { runGit } from "../src/git/run.ts";
import type { HostLookup } from "../src/git/urlSafety.ts";
import { createRepoRoutes, groupCommitters, type RepoDeps } from "../src/repos/routes.ts";
import type { Commit } from "../src/git/commits.ts";
import {
  commitFiles,
  initRepo,
  makeTempDir,
  mergeBranch,
  removeDir,
} from "./fixtures/gitRepo.ts";

const REPO_URL = "https://git.example.test/fixture.git";
const DUMMY_PAT = "ghp_TESTTOKEN0123456789abcdef";
const OWNER = "11111111-2222-3333-4444-555555555555";
const PUBLIC_LOOKUP: HostLookup = async () => [
  { address: "93.184.216.34", family: 4 },
];

const LS_REMOTE_OK =
  "ref: refs/heads/main\tHEAD\n" +
  "1111111111111111111111111111111111111111\trefs/heads/main\n" +
  "2222222222222222222222222222222222222222\trefs/heads/develop\n";

const COMMITTERS_BODY = {
  repoUrl: REPO_URL,
  branch: "main",
  dateFrom: "2026-08-01",
  dateTo: "2026-08-07",
};

let root: string;
let source: string;

beforeAll(async () => {
  root = await makeTempDir("code-report-repos-");
  source = join(root, "source");
  await mkdir(source, { recursive: true });
  await initRepo(source);
  await commitFiles(source, {
    message: "feat: the scheduling grid",
    date: "2026-08-03T10:00:00+07:00",
    authorName: "Somchai Jaidee",
    authorEmail: "somchai@x.co.th",
    files: { "README.md": "# fixture\n" },
  });
  await commitFiles(source, {
    message: "fix: the grid header",
    date: "2026-08-04T10:00:00+07:00",
    authorName: "Somchai Jaidee",
    authorEmail: "somchai@x.co.th",
    files: { "src/grid.ts": "export const grid = 1;\n" },
  });
  await commitFiles(source, {
    message: "docs: how to run it",
    date: "2026-08-05T10:00:00+07:00",
    authorName: "Areeya Chan",
    authorEmail: "areeya@x.co.th",
    files: { "docs/run.md": "# run\n" },
  });
  // A merge commit, authored by the fixture's own identity: `commitLogArgs`
  // passes `--no-merges`, so "Fixture Bot" must not appear in the list.
  await mergeBranch(source, {
    branch: "side",
    commit: {
      message: "chore: side work",
      date: "2026-08-06T10:00:00+07:00",
      authorName: "Areeya Chan",
      authorEmail: "areeya@x.co.th",
      files: { "docs/side.md": "# side\n" },
    },
  });
});

afterAll(async () => {
  await removeDir(root);
});

type App = {
  cloneDirs: string[];
  spawned: string[][];
  request(path: string, init?: RequestInit & { cookie?: string }): Promise<Response>;
};

function buildApp(runner: (app: App) => GitRunner, deps: Partial<RepoDeps> = {}): App {
  const cloneDirs: string[] = [];
  const spawned: string[][] = [];
  const app = new Hono<SessionEnv>();

  const self: App = {
    cloneDirs,
    spawned,
    async request(path, init = {}) {
      const { cookie, ...rest } = init;
      const headers = new Headers(rest.headers);
      if (cookie !== undefined) headers.set("Cookie", cookie);
      return app.request(path, { ...rest, headers });
    },
  };

  const wrapped: GitRunner = async (args, options) => {
    spawned.push(args);
    if (args.includes("clone")) {
      const dir = args[args.length - 1];
      if (dir !== undefined) cloneDirs.push(dir);
    }
    return runner(self)(args, options);
  };

  app.use("/api/repos", requireSession);
  app.use("/api/repos/*", requireSession);
  app.route(
    "/api/repos",
    createRepoRoutes({
      allowPrivateHosts: false,
      timeZone: "Asia/Bangkok",
      lookup: PUBLIC_LOOKUP,
      gitRunner: wrapped,
      ...deps,
    }),
  );

  return self;
}

/** A runner that answers `ls-remote` and refuses to do anything else. */
function lsRemoteRunner(result: Partial<GitRun>): (app: App) => GitRunner {
  return () => async () => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    ...result,
  });
}

/** The real git, with the clone's remote rewritten to the local fixture. */
function fixtureRunner(path: string): (app: App) => GitRunner {
  return () => async (args, options) => {
    if (args.includes("clone")) {
      const rewritten = [...args];
      rewritten[rewritten.length - 2] = path;
      return runGit(rewritten, options);
    }
    return runGit(args, options);
  };
}

async function json<T = Record<string, any>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function cookieFor(userId: string): Promise<string> {
  return `${SESSION_COOKIE}=${await signSession(userId)}`;
}

function post(app: App, path: string, body: unknown, cookie?: string) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept-Language": "en" },
    body: JSON.stringify(body),
    ...(cookie === undefined ? {} : { cookie }),
  });
}

async function directoryExists(dir: string): Promise<boolean> {
  try {
    await stat(dir);
    return true;
  } catch {
    return false;
  }
}

describe("the session gate (TASK-017 §4)", () => {
  test("an unauthenticated POST to either path is 401 and starts no git", async () => {
    for (const path of ["/api/repos/branches", "/api/repos/committers"]) {
      const app = buildApp(lsRemoteRunner({ stdout: LS_REMOTE_OK }));
      const response = await post(app, path, COMMITTERS_BODY);
      expect(response.status).toBe(401);
      expect((await json(response)).error.code).toBe("AUTH_REQUIRED");
      expect(app.spawned).toHaveLength(0);
    }
  });
});

describe("POST /api/repos/branches", () => {
  test("a valid body returns the branches and the default branch", async () => {
    const app = buildApp(lsRemoteRunner({ stdout: LS_REMOTE_OK }));
    const response = await post(
      app,
      "/api/repos/branches",
      { repoUrl: REPO_URL },
      await cookieFor(OWNER),
    );
    expect(response.status).toBe(200);
    expect(await json<Record<string, unknown>>(response)).toEqual({
      branches: ["main", "develop"],
      defaultBranch: "main",
    });
  });

  test("an empty remote is 200 with an empty list, not an error", async () => {
    const app = buildApp(lsRemoteRunner({ stdout: "" }));
    const response = await post(
      app,
      "/api/repos/branches",
      { repoUrl: REPO_URL },
      await cookieFor(OWNER),
    );
    expect(response.status).toBe(200);
    expect(await json<Record<string, unknown>>(response)).toEqual({
      branches: [],
      defaultBranch: null,
    });
  });

  test("the PAT is on argv as an extraHeader, never in the URL, never echoed", async () => {
    const app = buildApp(lsRemoteRunner({ stdout: LS_REMOTE_OK }));
    const response = await post(
      app,
      "/api/repos/branches",
      { repoUrl: REPO_URL, pat: DUMMY_PAT },
      await cookieFor(OWNER),
    );
    expect(response.status).toBe(200);
    const args = app.spawned[0] as string[];
    expect(args).toContain(`http.extraHeader=${authorizationHeader(DUMMY_PAT)}`);
    expect(args[args.length - 1]).toBe(REPO_URL);
    expect(await response.text()).not.toContain(DUMMY_PAT);
  });

  test("a repoUrl carrying userinfo is 400 and no git process is spawned", async () => {
    const app = buildApp(lsRemoteRunner({ stdout: LS_REMOTE_OK }));
    const response = await post(
      app,
      "/api/repos/branches",
      { repoUrl: `https://x-access-token:${DUMMY_PAT}@github.com/o/r.git` },
      await cookieFor(OWNER),
    );
    expect(response.status).toBe(400);
    const body = await json(response);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(Object.keys(body.error.fields)).toEqual(["repoUrl"]);
    expect(app.spawned).toHaveLength(0);
    expect(JSON.stringify(body)).not.toContain(DUMMY_PAT);
  });

  test("git@ / ssh:// / file:// are 400, with no git process", async () => {
    for (const repoUrl of [
      "git@github.com:o/r.git",
      "ssh://git@github.com/o/r.git",
      "file:///etc/passwd",
    ]) {
      const app = buildApp(lsRemoteRunner({ stdout: LS_REMOTE_OK }));
      const response = await post(
        app,
        "/api/repos/branches",
        { repoUrl },
        await cookieFor(OWNER),
      );
      expect(response.status).toBe(400);
      expect((await json(response)).error.fields.repoUrl).toBe(
        "Must be a valid http or https address.",
      );
      expect(app.spawned).toHaveLength(0);
    }
  });

  test("a missing repoUrl is 400 REQUIRED", async () => {
    const app = buildApp(lsRemoteRunner({ stdout: LS_REMOTE_OK }));
    const response = await post(app, "/api/repos/branches", {}, await cookieFor(OWNER));
    expect(response.status).toBe(400);
    expect((await json(response)).error.fields).toEqual({
      repoUrl: "This field is required.",
    });
  });

  test("a remote failure is 502 with SPEC-001's existing code and message", async () => {
    const app = buildApp(
      lsRemoteRunner({ exitCode: 128, stderr: "remote: Repository not found." }),
    );
    const response = await post(
      app,
      "/api/repos/branches",
      { repoUrl: REPO_URL },
      await cookieFor(OWNER),
    );
    expect(response.status).toBe(502);
    const body = await json(response);
    expect(body.error.code).toBe("REPO_AUTH_FAILED");
    expect(body.error.message).toContain("access token");
  });

  test("a timeout is 502 CLONE_TIMEOUT", async () => {
    const app = buildApp(lsRemoteRunner({ exitCode: 143, timedOut: true }));
    const response = await post(
      app,
      "/api/repos/branches",
      { repoUrl: REPO_URL },
      await cookieFor(OWNER),
    );
    expect(response.status).toBe(502);
    expect((await json(response)).error.code).toBe("CLONE_TIMEOUT");
  });
});

describe("POST /api/repos/committers — validation", () => {
  test("branch, dateFrom and dateTo are all required here", async () => {
    const app = buildApp(lsRemoteRunner({}));
    const response = await post(
      app,
      "/api/repos/committers",
      { repoUrl: REPO_URL },
      await cookieFor(OWNER),
    );
    expect(response.status).toBe(400);
    expect((await json(response)).error.fields).toEqual({
      branch: "This field is required.",
      dateFrom: "This field is required.",
      dateTo: "This field is required.",
    });
    expect(app.spawned).toHaveLength(0);
  });

  test("the span bound is the report's exclusive one: 366 accepted, 367 rejected", async () => {
    // 2026-08-01 → 2027-08-02 is 366 days; one more is 367.
    const accepted = buildApp(fixtureRunner(source));
    const okResponse = await post(
      accepted,
      "/api/repos/committers",
      { ...COMMITTERS_BODY, dateFrom: "2026-08-01", dateTo: "2027-08-02" },
      await cookieFor(OWNER),
    );
    expect(okResponse.status).toBe(200);

    const rejected = buildApp(lsRemoteRunner({}));
    const badResponse = await post(
      rejected,
      "/api/repos/committers",
      { ...COMMITTERS_BODY, dateFrom: "2026-08-01", dateTo: "2027-08-03" },
      await cookieFor(OWNER),
    );
    expect(badResponse.status).toBe(400);
    expect((await json(badResponse)).error.fields).toEqual({
      dateTo: "The period must not be longer than 366 days.",
    });
    expect(rejected.spawned).toHaveLength(0);
  }, 60_000);

  test("dateTo before dateFrom is DATE_ORDER", async () => {
    const app = buildApp(lsRemoteRunner({}));
    const response = await post(
      app,
      "/api/repos/committers",
      { ...COMMITTERS_BODY, dateFrom: "2026-08-07", dateTo: "2026-08-01" },
      await cookieFor(OWNER),
    );
    expect(response.status).toBe(400);
    expect((await json(response)).error.fields).toEqual({
      dateTo: "Must not be before dateFrom.",
    });
  });
});

describe("POST /api/repos/committers — the list", () => {
  test("the committers of the window, most commits first, merges excluded", async () => {
    const app = buildApp(fixtureRunner(source));
    const response = await post(
      app,
      "/api/repos/committers",
      COMMITTERS_BODY,
      await cookieFor(OWNER),
    );
    expect(response.status).toBe(200);
    const body = await json(response);
    // Two each, so the tie is broken by name ascending.
    expect(body).toEqual({
      committers: [
        { name: "Areeya Chan", email: "areeya@x.co.th", commits: 2 },
        { name: "Somchai Jaidee", email: "somchai@x.co.th", commits: 2 },
      ],
    });
    // The merge commit's author is not in the list.
    expect(JSON.stringify(body)).not.toContain("Fixture Bot");
  }, 60_000);

  test("the temp directory is under tempRoot() and is deleted on success", async () => {
    const app = buildApp(fixtureRunner(source));
    const response = await post(
      app,
      "/api/repos/committers",
      COMMITTERS_BODY,
      await cookieFor(OWNER),
    );
    expect(response.status).toBe(200);
    const dir = app.cloneDirs[0] as string;
    expect(dir.startsWith(tempRoot())).toBe(true);
    expect(await directoryExists(dir)).toBe(false);
  }, 60_000);

  test("the temp directory is deleted when the body throws, and the answer is 502", async () => {
    const app = buildApp(
      () => async (args, options) => {
        if (args.includes("clone")) {
          const rewritten = [...args];
          rewritten[rewritten.length - 2] = source;
          return runGit(rewritten, options);
        }
        // `git log` fails after a successful clone: `readCommits` throws
        // inside `withClone`'s body, which is the path that must still clean up.
        return {
          exitCode: 128,
          stdout: "",
          stderr: "fatal: your current branch does not have any commits yet",
          timedOut: false,
        };
      },
    );
    const response = await post(
      app,
      "/api/repos/committers",
      COMMITTERS_BODY,
      await cookieFor(OWNER),
    );
    expect(response.status).toBe(502);
    expect((await json(response)).error.code).toBe("CLONE_FAILED");
    const dir = app.cloneDirs[0] as string;
    expect(await directoryExists(dir)).toBe(false);
  }, 60_000);
});

describe("groupCommitters", () => {
  function commit(authorName: string, authorEmail: string): Commit {
    return {
      sha: "x",
      shortSha: "x",
      authorName,
      authorEmail,
      date: "2026-08-03T10:00:00+07:00",
      subject: "s",
      body: "",
      files: [],
      insertions: 0,
      deletions: 0,
      diff: "",
      diffTruncated: false,
    };
  }

  test("groups by e-mail, counts commits, sorts by count then name", () => {
    expect(
      groupCommitters([
        commit("Areeya Chan", "areeya@x.co.th"),
        commit("Somchai Jaidee", "somchai@x.co.th"),
        commit("Somchai (laptop)", "somchai@x.co.th"),
        commit("Bee Nak", "bee@x.co.th"),
      ]),
    ).toEqual([
      { name: "Somchai Jaidee", email: "somchai@x.co.th", commits: 2 },
      { name: "Areeya Chan", email: "areeya@x.co.th", commits: 1 },
      { name: "Bee Nak", email: "bee@x.co.th", commits: 1 },
    ]);
  });

  test("falls back to the name when a commit carries no e-mail", () => {
    expect(groupCommitters([commit("No Email", ""), commit("No Email", "")])).toEqual([
      { name: "No Email", email: "", commits: 2 },
    ]);
  });
});
