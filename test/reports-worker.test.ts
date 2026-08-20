/**
 * TASK-005 §2, §3, §6, §7 — the worker.
 *
 * A real `git` against a fixture repository and a fake `AiClient`: no network
 * and no database (SPEC-001 "Testing"). The only seam is the clone's remote —
 * the URL gate demands an http(s) address, so the runner rewrites the remote
 * of the `clone` invocation to the fixture's path on disk and delegates every
 * other invocation (`ls-files`, `log`, `show`) to the real `runGit`.
 */

process.env.DATABASE_URL ??= "postgres://user:pw@127.0.0.1:5432/code_report_test";
process.env.SESSION_SECRET ??= "test-session-secret-not-a-real-one";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ChatRequest } from "../src/ai/client.ts";
import { jobTempDir } from "../src/git/cleanup.ts";
import { runGit, type GitRunner } from "../src/git/run.ts";
import type { HostLookup } from "../src/git/urlSafety.ts";
import { JOB_STAGES, stageProgress, type ReportJob } from "../src/reports/jobs.ts";
import { createReportWorker } from "../src/reports/worker.ts";
import { fakeAiClient, type FakeAiClient } from "./fixtures/aiClient.ts";
import { memoryJobRepository, type MemoryJobRepository } from "./fixtures/jobRepository.ts";
import { commitFiles, initRepo, makeTempDir, removeDir } from "./fixtures/gitRepo.ts";

const REPO_URL = "https://git.example.test/fixture.git";
const DUMMY_PAT = "ghp_TESTTOKEN0123456789abcdef";
const USER_ID = "11111111-2222-3333-4444-555555555555";

/** Never resolves a name: every test supplies its own address. */
const PUBLIC_LOOKUP: HostLookup = async () => [
  { address: "93.184.216.34", family: 4 },
];

let root: string;
let source: string;
let emptySource: string;

beforeAll(async () => {
  root = await makeTempDir("code-report-worker-");

  source = join(root, "source");
  await mkdir(source, { recursive: true });
  await initRepo(source);
  await commitFiles(source, {
    message: "feat: the scheduling grid",
    date: "2026-08-03T10:00:00+07:00",
    authorName: "Somchai Jaidee",
    authorEmail: "somchai@x.co.th",
    files: {
      "README.md": "# fixture\n\nA scheduling tool.\n",
      "src/grid.ts": "export const grid = 1;\n",
    },
  });
  await commitFiles(source, {
    message: "fix: off-by-one in the grid",
    date: "2026-08-05T09:00:00+07:00",
    authorName: "Malee Rungrueang",
    authorEmail: "malee@x.co.th",
    files: { "src/grid.ts": "export const grid = 2;\n" },
  });

  // A repository whose only commit is outside every window we ask for.
  emptySource = join(root, "quiet");
  await mkdir(emptySource, { recursive: true });
  await initRepo(emptySource);
  await commitFiles(emptySource, {
    message: "chore: init",
    date: "2020-01-01T10:00:00+07:00",
    authorName: "Somchai Jaidee",
    authorEmail: "somchai@x.co.th",
    files: { "README.md": "# quiet\n" },
  });
});

afterAll(async () => {
  await removeDir(root);
});

/** Real git everywhere; only the clone's remote is redirected to `path`. */
function fixtureRunner(path: string): GitRunner {
  return async (args, options) => {
    if (args.includes("clone")) {
      const rewritten = [...args];
      // buildCloneArgs puts the remote second-to-last and the target dir last.
      rewritten[rewritten.length - 2] = path;
      return runGit(rewritten, options);
    }
    return runGit(args, options);
  };
}

type Harness = {
  jobs: MemoryJobRepository;
  ai: FakeAiClient;
  logs: string[];
  run(job: Partial<ReportJob>, pat?: string): Promise<ReportJob>;
};

function harness(
  options: {
    runner?: GitRunner;
    maxConcurrent?: number;
    reply?: (request: ChatRequest, index: number) => string;
  } = {},
): Harness {
  const jobs = memoryJobRepository();
  const ai = fakeAiClient(options.reply);
  const logs: string[] = [];
  const worker = createReportWorker({
    jobs,
    createAiClient: () => ai,
    allowPrivateHosts: false,
    timeZone: "Asia/Bangkok",
    maxConcurrent: options.maxConcurrent ?? 2,
    log: (line) => logs.push(line),
    gitRunner: options.runner ?? fixtureRunner(source),
    lookup: PUBLIC_LOOKUP,
  });

  return {
    jobs,
    ai,
    logs,
    async run(overrides: Partial<ReportJob>, pat?: string): Promise<ReportJob> {
      const job = await jobs.create({
        userId: USER_ID,
        repoUrl: REPO_URL,
        dateFrom: "2026-08-01",
        dateTo: "2026-08-07",
        language: "en",
        ...overrides,
      });
      await worker.enqueue({ ...job, ...overrides }, pat);
      return jobs.get(job.id);
    },
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("the happy path", () => {
  test("QUEUED → RUNNING → DONE, with the report and the commit count stored", async () => {
    const h = harness({ reply: (request) => `<<${request.stage}>>` });
    const job = await h.run({});

    expect(job.status).toBe("DONE");
    expect(job.commitCount).toBe(2);
    expect(job.reportMd).toBe("<<AI_WRITING>>");
    expect(job.stage).toBeUndefined();
    expect(job.errorCode).toBeUndefined();
  }, 60_000);

  test("the six stages are announced in SPEC-001's order", async () => {
    const h = harness();
    await h.run({});
    expect(h.jobs.stages).toEqual([...JOB_STAGES]);
  }, 60_000);

  test("progress derived from a real run's stages is always current/6", async () => {
    const h = harness();
    await h.run({});
    // Asserted on the stages the worker actually reported, not on a constant.
    const seen = h.jobs.stages.map((stage) => stageProgress(stage));
    expect(seen).toHaveLength(6);
    for (const progress of seen) expect(progress.total).toBe(6);
    expect(seen.map((p) => p.current)).toEqual([1, 2, 3, 4, 5, 6]);
  }, 60_000);

  test("the temp dir is gone after a successful run", async () => {
    const h = harness();
    const job = await h.run({});
    expect(await exists(jobTempDir(job.id))).toBe(false);
  }, 60_000);

  test("the pipeline is given the stored YYYY-MM-DD dates, and prints DD/MMM/YY", async () => {
    const h = harness();
    await h.run({});
    const text = h.ai.allPromptText();
    expect(text).toContain("Period: 01/Aug/26 – 07/Aug/26");
    expect(text).not.toContain("2026-08-01");
  }, 60_000);
});

describe("zero commits", () => {
  test("ends NO_COMMITS with commitCount 0, the templated note, and NO AI call", async () => {
    const h = harness({ runner: fixtureRunner(emptySource) });
    const job = await h.run({ dateFrom: "2026-08-01", dateTo: "2026-08-07" });

    expect(job.status).toBe("NO_COMMITS");
    expect(job.commitCount).toBe(0);
    expect(job.reportMd).toContain("No commits were found");
    expect(job.reportMd).toContain("01/Aug/26 – 07/Aug/26");
    expect(h.ai.requests).toHaveLength(0);
  }, 60_000);
});

describe("failures", () => {
  test("a failing clone ends FAILED with the mapped code and no report", async () => {
    const h = harness({
      runner: async () => ({
        exitCode: 128,
        stdout: "",
        stderr: "remote: Repository not found.\nfatal: repository not found",
        timedOut: false,
      }),
    });
    const job = await h.run({});

    expect(job.status).toBe("FAILED");
    expect(job.errorCode).toBe("REPO_AUTH_FAILED");
    expect(job.errorMessage).toContain("access token");
    expect(job.reportMd).toBeUndefined();
  });

  test("a clone timeout ends FAILED and the temp dir it created is removed", async () => {
    let created: string | undefined;
    const h = harness({
      runner: async (args) => {
        created = args[args.length - 1];
        await mkdir(created as string, { recursive: true });
        return { exitCode: 143, stdout: "", stderr: "", timedOut: true };
      },
    });
    const job = await h.run({});

    expect(job.status).toBe("FAILED");
    expect(job.errorCode).toBe("CLONE_TIMEOUT");
    expect(created).toBe(jobTempDir(job.id));
    expect(await exists(created as string)).toBe(false);
  });

  test("a readCommits failure on a missing branch ends FAILED, never NO_COMMITS", async () => {
    const h = harness({
      runner: async (args, options) => {
        if (args.includes("log")) {
          return {
            exitCode: 128,
            stdout: "",
            stderr:
              "fatal: ambiguous argument 'nope': unknown revision or path not in the working tree.",
            timedOut: false,
          };
        }
        return fixtureRunner(source)(args, options);
      },
    });
    const job = await h.run({ branch: "nope" });

    expect(job.status).toBe("FAILED");
    expect(job.errorCode).toBe("BRANCH_NOT_FOUND");
    expect(job.errorMessage).toContain("nope");
    expect(job.commitCount).toBeUndefined();
  }, 60_000);

  test("a clone that yields zero files ends FAILED and runs no AI stage", async () => {
    const h = harness({
      runner: async (args, options) => {
        // The clone succeeds; `git ls-files` then fails, which `listRepoFiles`
        // reports as an empty project (TASK-005 §6).
        if (args.includes("ls-files")) {
          return { exitCode: 128, stdout: "", stderr: "fatal: not a git repository", timedOut: false };
        }
        return fixtureRunner(source)(args, options);
      },
    });
    const job = await h.run({});

    expect(job.status).toBe("FAILED");
    expect(job.errorCode).toBe("CLONE_FAILED");
    expect(h.ai.requests).toHaveLength(0);
    expect(h.jobs.stages).toEqual(["CLONING", "READING_CODEBASE"]);
    expect(await exists(jobTempDir(job.id))).toBe(false);
  }, 60_000);

  test("an AI failure ends FAILED with AI_UNAVAILABLE", async () => {
    const jobs = memoryJobRepository();
    const worker = createReportWorker({
      jobs,
      createAiClient: () => ({
        async chat() {
          const { AiLayerError } = await import("../src/ai/errors.ts");
          throw new AiLayerError("AI_UNAVAILABLE", { detail: "no response" });
        },
      }),
      allowPrivateHosts: false,
      timeZone: "Asia/Bangkok",
      maxConcurrent: 2,
      log: () => {},
      gitRunner: fixtureRunner(source),
      lookup: PUBLIC_LOOKUP,
    });
    const job = await jobs.create({
      userId: USER_ID,
      repoUrl: REPO_URL,
      dateFrom: "2026-08-01",
      dateTo: "2026-08-07",
      language: "th",
    });
    await worker.enqueue(job, undefined);

    const stored = jobs.get(job.id);
    expect(stored.status).toBe("FAILED");
    expect(stored.errorCode).toBe("AI_UNAVAILABLE");
    // The message is in the job's report language.
    expect(stored.errorMessage).toContain("ระบบวิเคราะห์");
    expect(await exists(jobTempDir(job.id))).toBe(false);
  }, 60_000);
});

describe("concurrency", () => {
  test("a third job stays QUEUED while two run", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const jobs = memoryJobRepository();
    const worker = createReportWorker({
      jobs,
      createAiClient: () => fakeAiClient(),
      allowPrivateHosts: false,
      timeZone: "Asia/Bangkok",
      maxConcurrent: 2,
      log: () => {},
      gitRunner: async () => {
        await gate;
        return { exitCode: 128, stdout: "", stderr: "fatal: nope", timedOut: false };
      },
      lookup: PUBLIC_LOOKUP,
    });

    const created = [];
    for (let index = 0; index < 3; index += 1) {
      created.push(
        await jobs.create({
          userId: USER_ID,
          repoUrl: REPO_URL,
          dateFrom: "2026-08-01",
          dateTo: "2026-08-07",
          language: "en",
        }),
      );
    }
    const running = created.map((job) => worker.enqueue(job, undefined));

    // Let the two that got a slot reach their first status write.
    await Bun.sleep(20);
    expect(jobs.get(created[0]!.id).status).toBe("RUNNING");
    expect(jobs.get(created[1]!.id).status).toBe("RUNNING");
    expect(jobs.get(created[2]!.id).status).toBe("QUEUED");
    expect(jobs.get(created[2]!.id).stage).toBeUndefined();

    release();
    await Promise.all(running);
    expect(jobs.all().map((job) => job.status)).toEqual([
      "FAILED",
      "FAILED",
      "FAILED",
    ]);
  }, 60_000);
});

describe("PAT acceptance (SPEC-001 PAT handling 7)", () => {
  test("a run with a dummy token leaves it in no stored row and no log line", async () => {
    const h = harness();
    const job = await h.run({}, DUMMY_PAT);

    expect(job.status).toBe("DONE");
    // The whole "database": every column of every row.
    expect(h.jobs.dump()).not.toContain(DUMMY_PAT);
    expect(h.jobs.dump()).not.toContain("Authorization");
    // Every log line the worker emitted.
    expect(h.logs.join("\n")).not.toContain(DUMMY_PAT);
    // And nothing the AI was shown.
    expect(h.ai.allPromptText()).not.toContain(DUMMY_PAT);
  }, 60_000);
});
