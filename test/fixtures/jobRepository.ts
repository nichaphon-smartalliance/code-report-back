/**
 * An in-memory `JobRepository` (TASK-005).
 *
 * Same shape as TASK-002's in-memory `UserRepository`: the routes and the
 * worker take the repository as a dependency, so they are exercised in full
 * without a database. It also records every status/stage transition, which is
 * what the progress and concurrency assertions read.
 */

import type {
  JobFailure,
  JobRepository,
  JobRequest,
  JobStage,
  ReportJob,
} from "../../src/reports/jobs.ts";

export type MemoryJobRepository = JobRepository & {
  readonly rows: Map<string, ReportJob>;
  /** Every stage the worker announced, in order. */
  readonly stages: JobStage[];
  get(jobId: string): ReportJob;
  all(): ReportJob[];
  /** Everything ever written, for the PAT grep. */
  dump(): string;
};

export function memoryJobRepository(
  ids: () => string = defaultIds(),
): MemoryJobRepository {
  const rows = new Map<string, ReportJob>();
  const stages: JobStage[] = [];

  function mutate(jobId: string, change: Partial<ReportJob>): void {
    const row = rows.get(jobId);
    if (row === undefined) throw new Error(`no such job ${jobId}`);
    rows.set(jobId, { ...row, ...change });
  }

  return {
    rows,
    stages,

    get(jobId: string): ReportJob {
      const row = rows.get(jobId);
      if (row === undefined) throw new Error(`no such job ${jobId}`);
      return row;
    },

    all(): ReportJob[] {
      return [...rows.values()];
    },

    dump(): string {
      return JSON.stringify([...rows.values()]);
    },

    async create(request: JobRequest): Promise<ReportJob> {
      const job: ReportJob = {
        ...request,
        id: ids(),
        status: "QUEUED",
        stage: undefined,
        commitCount: undefined,
        reportMd: undefined,
        errorCode: undefined,
        errorMessage: undefined,
      };
      rows.set(job.id, job);
      return job;
    },

    async findForUser(
      jobId: string,
      userId: string,
    ): Promise<ReportJob | undefined> {
      const row = rows.get(jobId);
      return row !== undefined && row.userId === userId ? row : undefined;
    },

    async setStage(jobId: string, stage: JobStage): Promise<void> {
      stages.push(stage);
      mutate(jobId, { status: "RUNNING", stage });
    },

    async finishDone(
      jobId: string,
      result: { reportMd: string; commitCount: number },
    ): Promise<void> {
      mutate(jobId, {
        status: "DONE",
        stage: undefined,
        reportMd: result.reportMd,
        commitCount: result.commitCount,
      });
    },

    async finishNoCommits(
      jobId: string,
      result: { reportMd: string },
    ): Promise<void> {
      mutate(jobId, {
        status: "NO_COMMITS",
        stage: undefined,
        reportMd: result.reportMd,
        commitCount: 0,
      });
    },

    async finishFailed(jobId: string, failure: JobFailure): Promise<void> {
      mutate(jobId, {
        status: "FAILED",
        stage: undefined,
        errorCode: failure.code,
        errorMessage: failure.message,
      });
    },
  };
}

/**
 * Ids are unique per repository instance **and across instances**: a job id
 * becomes a temp-directory name, so two suites that both started counting at 1
 * would clone into the same directory and fail each other intermittently.
 */
function defaultIds(): () => string {
  const run = Math.random().toString(36).slice(2, 10);
  let next = 0;
  return () => {
    next += 1;
    return `job-${run}-${String(next).padStart(4, "0")}`;
  };
}
