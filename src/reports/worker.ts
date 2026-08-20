/**
 * The in-process report worker (TASK-005 §2, SPEC-001 "Flow — the worker").
 *
 * clone → tree → markdown → commits → three AI stages → persist → always
 * delete the clone. Everything it needs is injected, so the whole run is
 * exercisable against a fixture repository and a fake `AiClient` with no
 * network and no database.
 *
 * **The PAT is an argument, never a field.** It arrives from the route, lives
 * in this function's scope for the duration of the run, and is handed only to
 * the git layer, which passes it on argv as an `http.extraHeader`. It is not
 * on `ReportJob`, not on any log line, and not in any stored error message —
 * every message this module stores goes through TASK-003's redactor first.
 */

import type { AiClient } from "../ai/client.ts";
import { AiLayerError } from "../ai/errors.ts";
import { noCommitsReport } from "../ai/noCommitsReport.ts";
import { runPipeline } from "../ai/pipeline.ts";
import { errorMessage, type ErrorCode, type MessageParams } from "../errors/messages.ts";
import { GitLayerError } from "../git/errors.ts";
import { withClone } from "../git/clone.ts";
import { readCommits } from "../git/commits.ts";
import { readMarkdownDigest } from "../git/markdown.ts";
import { redact } from "../git/redact.ts";
import type { GitRunner } from "../git/run.ts";
import { readFileTree } from "../git/tree.ts";
import { RepoUrlError, type HostLookup } from "../git/urlSafety.ts";
import type { JobFailure, JobRepository, ReportJob } from "./jobs.ts";

export type WorkerLogSink = (line: string) => void;

export type WorkerOptions = {
  jobs: JobRepository;
  /**
   * Built per job so that every AI log line carries `jobId`/`userId`
   * (TASK-005 §7) without the AI layer having to know what a job is.
   */
  createAiClient: (context: { jobId: string; userId: string }) => AiClient;
  allowPrivateHosts: boolean;
  timeZone: string;
  maxConcurrent: number;
  log?: WorkerLogSink;
  /** Test seams, exactly as the git layer defines them. Never set in production. */
  gitRunner?: GitRunner;
  lookup?: HostLookup;
  cloneTimeoutMs?: number;
};

/**
 * Max N runs in flight process-wide (SPEC-001 "Limits"). A job that cannot
 * start yet simply waits here — its row stays `QUEUED`, which is exactly what
 * the poller should see.
 */
class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  release(): void {
    const next = this.waiting.shift();
    // Hand the slot straight over rather than lowering the count and racing.
    if (next !== undefined) next();
    else this.active -= 1;
  }
}

/**
 * Map anything thrown during a run onto SPEC-001's error table.
 *
 * `RepoUrlError` reaches this point only for the two gates that need DNS — a
 * host that resolves into a private range, or one that does not resolve at
 * all. Neither has its own code in SPEC-001's table, and `REPO_NOT_FOUND`
 * ("remote does not exist / not reachable") is the only row that describes
 * them. Recorded as a question rather than a new code, which is not mine to
 * invent.
 */
export function classifyRunFailure(error: unknown): {
  code: ErrorCode;
  params: MessageParams;
} {
  if (error instanceof GitLayerError) {
    const params: MessageParams = {};
    if (error.branch !== undefined) params.branch = error.branch;
    if (error.detail !== undefined) params.detail = error.detail;
    return { code: error.code, params };
  }
  if (error instanceof AiLayerError) {
    return { code: error.code, params: {} };
  }
  if (error instanceof RepoUrlError) {
    return { code: "REPO_NOT_FOUND", params: {} };
  }
  return { code: "INTERNAL", params: {} };
}

export type ReportWorker = {
  /**
   * Start a run. The returned promise settles when the job reaches a terminal
   * status and **never rejects** — a failed run is a stored status, not an
   * unhandled rejection in the HTTP process.
   */
  enqueue(job: ReportJob, pat: string | undefined): Promise<void>;
};

export function createReportWorker(options: WorkerOptions): ReportWorker {
  const { jobs } = options;
  const semaphore = new Semaphore(options.maxConcurrent);
  const log: WorkerLogSink = options.log ?? ((line) => console.log(line));

  const emit = (fields: Record<string, unknown>): void => {
    log(redact(JSON.stringify({ component: "worker", ...fields })));
  };

  async function execute(job: ReportJob, pat: string | undefined): Promise<void> {
    const started = Date.now();
    const base = { jobId: job.id, userId: job.userId };

    await jobs.setStage(job.id, "CLONING");
    emit({ ...base, msg: "started", stage: "CLONING" });

    await withClone(
      {
        jobId: job.id,
        repoUrl: job.repoUrl,
        ...(pat === undefined ? {} : { pat }),
        ...(job.branch === undefined ? {} : { branch: job.branch }),
        allowPrivateHosts: options.allowPrivateHosts,
        ...(options.gitRunner === undefined ? {} : { runner: options.gitRunner }),
        ...(options.lookup === undefined ? {} : { lookup: options.lookup }),
        ...(options.cloneTimeoutMs === undefined
          ? {}
          : { timeoutMs: options.cloneTimeoutMs }),
      },
      async (clone) => {
        const runner = options.gitRunner;

        await jobs.setStage(job.id, "READING_CODEBASE");
        const tree = await readFileTree(clone.dir, {
          ...(runner === undefined ? {} : { runner }),
        });
        if (tree.paths.length === 0) {
          // `listRepoFiles` returns [] both for an empty project and for a
          // `git ls-files` that failed — and a clone that succeeded always has
          // at least one file. Analysing "a project with no files" would send
          // the AI an empty tree and an empty digest and call the result a
          // report (TASK-005 §6).
          throw new GitLayerError("CLONE_FAILED", {
            detail: "the clone contains no readable files",
          });
        }
        const markdown = await readMarkdownDigest(clone.dir, {
          ...(runner === undefined ? {} : { runner }),
        });

        await jobs.setStage(job.id, "READING_COMMITS");
        const commits = await readCommits(clone.dir, {
          ...(job.branch === undefined ? {} : { branch: job.branch }),
          dateFrom: job.dateFrom,
          dateTo: job.dateTo,
          ...(job.author === undefined ? {} : { author: job.author }),
          timeZone: options.timeZone,
          ...(runner === undefined ? {} : { runner }),
        });

        if (commits.length === 0) {
          // A success with nothing to analyse: no AI call is made at all
          // (SPEC-001 "NO_COMMITS is a status, not an error").
          await jobs.finishNoCommits(job.id, {
            reportMd: noCommitsReport({
              repoUrl: job.repoUrl,
              branch: job.branch,
              author: job.author,
              dateFrom: job.dateFrom,
              dateTo: job.dateTo,
              language: job.language,
            }),
          });
          emit({
            ...base,
            msg: "finished",
            status: "NO_COMMITS",
            commitCount: 0,
            durationMs: Date.now() - started,
          });
          return;
        }

        const result = await runPipeline({
          client: options.createAiClient({ jobId: job.id, userId: job.userId }),
          tree,
          markdown,
          commits,
          params: {
            repoUrl: job.repoUrl,
            branch: job.branch,
            author: job.author,
            // The stored `YYYY-MM-DD` strings, unformatted: `formatReportParams`
            // renders `DD/MMM/YY` itself, so the display format lives in one
            // module and this job holds each date in exactly one shape
            // (TASK-005 §7, confirmed by Sober at the TASK-004 review).
            dateFrom: job.dateFrom,
            dateTo: job.dateTo,
            language: job.language,
          },
          ...(job.extraContext === undefined
            ? {}
            : { extraContext: job.extraContext }),
          // Only the stage name is taken. The pipeline's own position object
          // counts AI calls (a 41-commit run counts to five); the wire
          // `progress` counts stages and its total is six by definition, so it
          // is derived from the stage in `jobResponse` and never forwarded from
          // here (TASK-005 §7).
          onStage: (stage) => jobs.setStage(job.id, stage),
        });

        await jobs.finishDone(job.id, {
          reportMd: result.markdown,
          commitCount: commits.length,
        });
        emit({
          ...base,
          msg: "finished",
          status: "DONE",
          commitCount: commits.length,
          aiCalls: result.calls,
          durationMs: Date.now() - started,
        });
      },
    );
  }

  return {
    async enqueue(job: ReportJob, pat: string | undefined): Promise<void> {
      await semaphore.acquire();
      try {
        await execute(job, pat);
      } catch (error) {
        const { code, params } = classifyRunFailure(error);
        const failure: JobFailure = {
          code,
          // Redacted again on the way out even though every layer below
          // already redacts: this is the last point before the message
          // reaches the database, and PAT handling 5 is binding.
          message: redact(errorMessage(code, job.language, params)),
        };
        try {
          await jobs.finishFailed(job.id, failure);
        } catch (storeError) {
          emit({
            jobId: job.id,
            userId: job.userId,
            msg: "failed-to-store-failure",
            error: String(storeError),
          });
        }
        emit({
          jobId: job.id,
          userId: job.userId,
          msg: "finished",
          status: "FAILED",
          errorCode: code,
        });
      } finally {
        semaphore.release();
      }
    },
  };
}
