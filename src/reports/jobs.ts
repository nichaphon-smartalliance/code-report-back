/**
 * The report job — its shape, its stage list, and the repository that stores
 * it (TASK-005 §1, §2, §4; SPEC-001 "Data Model" / "GET /api/reports/:jobId").
 *
 * **There is no `pat` field on any type in this file and no `pat` column in
 * the table** (SPEC-001 "PAT handling" 3). The token travels as a separate
 * argument from the route to the worker and is never part of a job.
 *
 * The storage sits behind `JobRepository` for the same reason `UserRepository`
 * does in TASK-002: the routes and the worker are then exercisable without a
 * database, and the DB-backed implementation stays a handful of parameterised
 * statements.
 */

import { query, type Queryable } from "../db/index.ts";
import type { ErrorCode, Language } from "../errors/messages.ts";

/**
 * The six stages a reader is shown, in order (SPEC-001 `stage`).
 *
 * **`progress.total` is the length of this list — six.** The worker's "store"
 * and "clean up" steps have no stage value and are not counted: the frontend
 * renders exactly these six as a list, so a seventh would print "Step 7 / 7"
 * over six rows (SPEC-001, amended 2026-08-20).
 */
export const JOB_STAGES = [
  "CLONING",
  "READING_CODEBASE",
  "READING_COMMITS",
  "AI_PROJECT",
  "AI_COMMITS",
  "AI_WRITING",
] as const;

export type JobStage = (typeof JOB_STAGES)[number];

export type Progress = { current: number; total: number };

/**
 * The wire `progress` for a stage: `total` is always the number of stages and
 * `current` is the 1-based index of this one. Derived, never stored — a stored
 * pair can drift from the list; a derived one cannot.
 */
export function stageProgress(stage: JobStage): Progress {
  return { current: JOB_STAGES.indexOf(stage) + 1, total: JOB_STAGES.length };
}

export const JOB_STATUSES = [
  "QUEUED",
  "RUNNING",
  "DONE",
  "NO_COMMITS",
  "FAILED",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

/** What the user asked for. `pat` is deliberately absent — see the header. */
export type JobRequest = {
  userId: string;
  repoUrl: string;
  branch?: string | undefined;
  author?: string | undefined;
  /** `YYYY-MM-DD` — the wire, storage and `ReportParams` format everywhere. */
  dateFrom: string;
  dateTo: string;
  language: Language;
  extraContext?: string | undefined;
};

export type ReportJob = JobRequest & {
  id: string;
  status: JobStatus;
  stage: JobStage | undefined;
  commitCount: number | undefined;
  reportMd: string | undefined;
  errorCode: ErrorCode | undefined;
  errorMessage: string | undefined;
};

export type JobFailure = { code: ErrorCode; message: string };

export type JobRepository = {
  create(request: JobRequest): Promise<ReportJob>;
  /**
   * The job, **only if it belongs to `userId`**. A job owned by someone else is
   * indistinguishable from one that does not exist, which is what lets the
   * route answer `404` rather than `403` (SPEC-001).
   */
  findForUser(jobId: string, userId: string): Promise<ReportJob | undefined>;
  /** Move to RUNNING and record the stage the worker has reached. */
  setStage(jobId: string, stage: JobStage): Promise<void>;
  finishDone(
    jobId: string,
    result: { reportMd: string; commitCount: number },
  ): Promise<void>;
  finishNoCommits(jobId: string, result: { reportMd: string }): Promise<void>;
  finishFailed(jobId: string, failure: JobFailure): Promise<void>;
};

/* ------------------------------------------------------------------ *
 * The PostgreSQL implementation
 * ------------------------------------------------------------------ */

type JobRow = {
  id: string;
  user_id: string;
  repo_url: string;
  branch: string | null;
  author_filter: string | null;
  date_from: string | Date;
  date_to: string | Date;
  language: string;
  extra_context: string | null;
  status: string;
  stage: string | null;
  commit_count: number | null;
  report_md: string | null;
  error_code: string | null;
  error_message: string | null;
};

/**
 * `date` columns come back as a `Date` from `pg`, and a `Date` rendered in the
 * server's local zone can be the previous day. The stored value is a plain
 * calendar date, so it is read back as one — in UTC, where `pg` puts it.
 */
function isoDate(value: string | Date): string {
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function optional(value: string | null): string | undefined {
  return value === null ? undefined : value;
}

export function rowToJob(row: JobRow): ReportJob {
  return {
    id: row.id,
    userId: row.user_id,
    repoUrl: row.repo_url,
    branch: optional(row.branch),
    author: optional(row.author_filter),
    dateFrom: isoDate(row.date_from),
    dateTo: isoDate(row.date_to),
    language: row.language as Language,
    extraContext: optional(row.extra_context),
    status: row.status as JobStatus,
    stage: (optional(row.stage) as JobStage | undefined) ?? undefined,
    commitCount: row.commit_count ?? undefined,
    reportMd: optional(row.report_md),
    errorCode: (optional(row.error_code) as ErrorCode | undefined) ?? undefined,
    errorMessage: optional(row.error_message),
  };
}

const SELECT_COLUMNS = `id, user_id, repo_url, branch, author_filter,
         date_from, date_to, language, extra_context, status, stage,
         commit_count, report_md, error_code, error_message`;

export function createDbJobRepository(
  run: Queryable["query"] = query,
): JobRepository {
  return {
    async create(request: JobRequest): Promise<ReportJob> {
      const rows = await run<JobRow>(
        `INSERT INTO report_jobs
           (user_id, repo_url, branch, author_filter, date_from, date_to,
            language, extra_context, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'QUEUED')
         RETURNING ${SELECT_COLUMNS}`,
        [
          request.userId,
          request.repoUrl,
          request.branch ?? null,
          request.author ?? null,
          request.dateFrom,
          request.dateTo,
          request.language,
          request.extraContext ?? null,
        ],
      );
      const row = rows[0];
      if (row === undefined) throw new Error("report_jobs INSERT returned no row");
      return rowToJob(row);
    },

    async findForUser(
      jobId: string,
      userId: string,
    ): Promise<ReportJob | undefined> {
      const rows = await run<JobRow>(
        `SELECT ${SELECT_COLUMNS}
           FROM report_jobs
          WHERE id = $1 AND user_id = $2`,
        [jobId, userId],
      );
      const row = rows[0];
      return row === undefined ? undefined : rowToJob(row);
    },

    async setStage(jobId: string, stage: JobStage): Promise<void> {
      await run(
        `UPDATE report_jobs SET status = 'RUNNING', stage = $2 WHERE id = $1`,
        [jobId, stage],
      );
    },

    async finishDone(
      jobId: string,
      result: { reportMd: string; commitCount: number },
    ): Promise<void> {
      await run(
        `UPDATE report_jobs
            SET status = 'DONE', stage = NULL, report_md = $2,
                commit_count = $3, finished_at = now()
          WHERE id = $1`,
        [jobId, result.reportMd, result.commitCount],
      );
    },

    async finishNoCommits(
      jobId: string,
      result: { reportMd: string },
    ): Promise<void> {
      await run(
        `UPDATE report_jobs
            SET status = 'NO_COMMITS', stage = NULL, report_md = $2,
                commit_count = 0, finished_at = now()
          WHERE id = $1`,
        [jobId, result.reportMd],
      );
    },

    async finishFailed(jobId: string, failure: JobFailure): Promise<void> {
      await run(
        `UPDATE report_jobs
            SET status = 'FAILED', stage = NULL, error_code = $2,
                error_message = $3, finished_at = now()
          WHERE id = $1`,
        [jobId, failure.code, failure.message],
      );
    },
  };
}

export const dbJobRepository: JobRepository = createDbJobRepository();

/* ------------------------------------------------------------------ *
 * The wire shape
 * ------------------------------------------------------------------ */

export type JobResponse = {
  jobId: string;
  status: JobStatus;
  stage: JobStage | null;
  progress: Progress | null;
  params: {
    repoUrl: string;
    branch: string | null;
    author: string | null;
    dateFrom: string;
    dateTo: string;
    language: Language;
  };
  commitCount: number | null;
  report: { markdown: string; language: Language } | null;
  error: { code: ErrorCode; message: string } | null;
};

/**
 * `GET /api/reports/:jobId`'s body (SPEC-001).
 *
 * Built field by field rather than by spreading the job, so that **no field
 * can reach the wire by being added to the row** — `params` has six keys and
 * `pat` is not one of them, by construction rather than by deletion.
 *
 * `progress` is `null` exactly when `stage` is: a job that has not started (or
 * has finished) has no position in the list, and the frontend already treats
 * both as absent.
 */
export function jobResponse(job: ReportJob): JobResponse {
  return {
    jobId: job.id,
    status: job.status,
    stage: job.stage ?? null,
    progress: job.stage === undefined ? null : stageProgress(job.stage),
    params: {
      repoUrl: job.repoUrl,
      branch: job.branch ?? null,
      author: job.author ?? null,
      dateFrom: job.dateFrom,
      dateTo: job.dateTo,
      language: job.language,
    },
    commitCount: job.commitCount ?? null,
    report:
      job.reportMd === undefined
        ? null
        : { markdown: job.reportMd, language: job.language },
    error:
      job.errorCode === undefined
        ? null
        : { code: job.errorCode, message: job.errorMessage ?? "" },
  };
}
