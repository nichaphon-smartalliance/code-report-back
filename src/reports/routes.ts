/**
 * The two report endpoints — and only these two (TASK-005 §1, §4,
 * SPEC-001 "API → Reports").
 *
 *   POST /api/reports          → 202 { jobId } | 400 VALIDATION_ERROR
 *   GET  /api/reports/:jobId   → 200 <job>     | 404
 *
 * Both sit behind TASK-002's `requireSession`, which `src/index.ts` mounts on
 * `/api/reports` and `/api/reports/*` — so an unauthenticated call is answered
 * `401 AUTH_REQUIRED` and no job row is created and no work is started.
 *
 * **Request-body logging is off for this route** (SPEC-001 "PAT handling" 6):
 * nothing here logs, echoes or stores the body, and the PAT is passed straight
 * to the worker as an argument.
 */

import { Hono } from "hono";
import type { SessionEnv } from "../auth/middleware.ts";
import { createHttpAiClient } from "../ai/client.ts";
import { loadConfigOrExit } from "../config.ts";
import {
  errorEnvelope,
  fieldMessage,
  requestLanguage,
  validationEnvelope,
} from "../errors/index.ts";
import {
  dbJobRepository,
  jobResponse,
  type JobRepository,
} from "./jobs.ts";
import { validateCreateReport, type FieldIssues } from "./validate.ts";
import { createReportWorker, type ReportWorker } from "./worker.ts";

export type ReportDeps = {
  jobs: JobRepository;
  worker: ReportWorker;
};

function renderIssues(
  issues: FieldIssues,
  language: Parameters<typeof fieldMessage>[1],
): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [field, { issue, limit }] of Object.entries(issues)) {
    fields[field] = fieldMessage(
      issue,
      language,
      limit === undefined ? {} : { limit },
    );
  }
  return fields;
}

/** The real dependencies, built once on first use — never at import time. */
let production: ReportDeps | undefined;

function productionDeps(): ReportDeps {
  if (production === undefined) {
    const config = loadConfigOrExit();
    production = {
      jobs: dbJobRepository,
      worker: createReportWorker({
        jobs: dbJobRepository,
        createAiClient: ({ jobId, userId }) =>
          createHttpAiClient({
            baseUrl: config.AI_API_CENTER_URL,
            token: config.AI_API_CENTER_TOKEN,
            logBase: { jobId, userId },
          }),
        allowPrivateHosts: config.ALLOW_PRIVATE_GIT_HOSTS,
        timeZone: config.REPORT_TIMEZONE,
        maxConcurrent: config.MAX_CONCURRENT_JOBS,
      }),
    };
  }
  return production;
}

export function createReportRoutes(deps?: ReportDeps): Hono<SessionEnv> {
  const reports = new Hono<SessionEnv>();
  const resolve = (): ReportDeps => deps ?? productionDeps();

  reports.post("/", async (c) => {
    const language = requestLanguage(c);

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      // An unparseable body is a bad request, not an internal error. The body
      // itself is not echoed — it may carry a PAT.
      return c.json(
        validationEnvelope({ repoUrl: fieldMessage("REQUIRED", language) }, language),
        400,
      );
    }

    const validated = validateCreateReport(raw);
    if (!validated.ok) {
      return c.json(
        validationEnvelope(renderIssues(validated.issues, language), language),
        400,
      );
    }

    const { jobs, worker } = resolve();
    const { pat, ...request } = validated.value;
    const job = await jobs.create({ userId: c.get("userId"), ...request });

    // Deliberately not awaited: the run takes minutes and the client polls.
    // `enqueue` never rejects, so there is no unhandled rejection to catch.
    void worker.enqueue(job, pat);

    return c.json({ jobId: job.id }, 202);
  });

  reports.get("/:jobId", async (c) => {
    const { jobs } = resolve();
    const job = await jobs.findForUser(c.req.param("jobId"), c.get("userId"));
    if (job === undefined) {
      // Another user's job and a non-existent one are answered identically —
      // a 403 would confirm the id exists (SPEC-001).
      return c.json(errorEnvelope("INTERNAL", requestLanguage(c)), 404);
    }
    return c.json(jobResponse(job), 200);
  });

  return reports;
}
