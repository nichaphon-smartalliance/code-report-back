/**
 * The two repository-inspection endpoints — and only these two (TASK-017 §3,
 * SPEC-003 "API / Interface Design").
 *
 *   POST /api/repos/branches    → 200 { branches, defaultBranch }
 *   POST /api/repos/committers  → 200 { committers }
 *
 * Both sit behind TASK-002's `requireSession`, which `src/index.ts` mounts on
 * `/api/repos` and `/api/repos/*` **before** these routes exist — so an
 * unauthenticated call is answered `401 AUTH_REQUIRED` and no git process is
 * started.
 *
 * **Read-only by construction:** no table, no column, no job row, no AI call,
 * no config key. The committer clone is metadata-only and its temp directory is
 * deleted by `withClone`'s `finally` on success, on throw and on timeout.
 *
 * **Request-body logging is off for these routes** (SPEC-001 "PAT handling" 6):
 * nothing here logs, echoes or stores the body, and the PAT is passed straight
 * to the git layer, which puts it on argv as an `http.extraHeader`.
 */

import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import type { SessionEnv } from "../auth/middleware.ts";
import { loadConfigOrExit } from "../config.ts";
import {
  errorEnvelope,
  fieldMessage,
  requestLanguage,
  validationEnvelope,
  type Language,
} from "../errors/index.ts";
import { withClone } from "../git/clone.ts";
import { readCommits, type Commit } from "../git/commits.ts";
import { GitLayerError } from "../git/errors.ts";
import { listRemoteBranches } from "../git/lsRemote.ts";
import type { GitRunner } from "../git/run.ts";
import { RepoUrlError, type HostLookup } from "../git/urlSafety.ts";
import { classifyRunFailure } from "../reports/worker.ts";
import type { FieldIssues } from "../reports/validate.ts";
import { validateBranchesBody, validateCommittersBody } from "./validate.ts";

/**
 * 2 minutes (SPEC-003 Decision 2.4). The worker's 10-minute budget belongs to a
 * run the user is already watching a progress bar for; a form control is not.
 */
export const INSPECT_CLONE_TIMEOUT_MS = 120_000;

export type Committer = { name: string; email: string; commits: number };

export type RepoDeps = {
  allowPrivateHosts: boolean;
  timeZone: string;
  /** Test seams, exactly as the git layer defines them. Never set in production. */
  gitRunner?: GitRunner | undefined;
  lookup?: HostLookup | undefined;
  cloneTimeoutMs?: number | undefined;
  lsRemoteTimeoutMs?: number | undefined;
};

function renderIssues(issues: FieldIssues, language: Language): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [field, { issue, limit }] of Object.entries(issues)) {
    fields[field] = fieldMessage(issue, language, limit === undefined ? {} : { limit });
  }
  return fields;
}

/**
 * Distinct committers with a commit count each.
 *
 * Grouped by e-mail when there is one, else by name: `--author` is matched
 * `--fixed-strings`, so the address is the narrowest unambiguous needle, and
 * two humans share a display name far more often than an address (SPEC-003
 * Decision 2.3). Sorted by commits descending, then name ascending — a stable
 * order, most work first.
 */
export function groupCommitters(commits: Commit[]): Committer[] {
  const byKey = new Map<string, Committer>();
  for (const commit of commits) {
    const key = commit.authorEmail === "" ? commit.authorName : commit.authorEmail;
    const found = byKey.get(key);
    if (found === undefined) {
      byKey.set(key, {
        name: commit.authorName,
        email: commit.authorEmail,
        commits: 1,
      });
    } else {
      found.commits += 1;
    }
  }
  return [...byKey.values()].sort(
    (a, b) => b.commits - a.commits || a.name.localeCompare(b.name),
  );
}

/** The real dependencies, built once on first use — never at import time. */
let production: RepoDeps | undefined;

function productionDeps(): RepoDeps {
  if (production === undefined) {
    const config = loadConfigOrExit();
    production = {
      allowPrivateHosts: config.ALLOW_PRIVATE_GIT_HOSTS,
      timeZone: config.REPORT_TIMEZONE,
    };
  }
  return production;
}

export function createRepoRoutes(deps?: RepoDeps): Hono<SessionEnv> {
  const repos = new Hono<SessionEnv>();
  const resolve = (): RepoDeps => deps ?? productionDeps();

  /**
   * A failure the remote is responsible for is a `502` carrying SPEC-001's
   * existing code and message. `RepoUrlError` reaches here only for the two
   * gates that need DNS (private range, unresolvable), and it is mapped by the
   * worker's own `classifyRunFailure` so the two paths cannot answer
   * differently. Anything else is re-thrown to `app.onError` — a bug is a 500,
   * not a story about the remote.
   */
  const remoteFailure = (error: unknown, language: Language) => {
    if (!(error instanceof GitLayerError) && !(error instanceof RepoUrlError)) {
      throw error;
    }
    const { code, params } = classifyRunFailure(error);
    return errorEnvelope(code, language, params);
  };

  repos.post("/branches", async (c) => {
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

    const validated = validateBranchesBody(raw);
    if (!validated.ok) {
      return c.json(
        validationEnvelope(renderIssues(validated.issues, language), language),
        400,
      );
    }

    const { allowPrivateHosts, gitRunner, lookup, lsRemoteTimeoutMs } = resolve();
    try {
      const result = await listRemoteBranches({
        repoUrl: validated.value.repoUrl,
        pat: validated.value.pat,
        allowPrivateHosts,
        runner: gitRunner,
        lookup,
        timeoutMs: lsRemoteTimeoutMs,
      });
      return c.json(result, 200);
    } catch (error) {
      return c.json(remoteFailure(error, language), 502);
    }
  });

  repos.post("/committers", async (c) => {
    const language = requestLanguage(c);

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(
        validationEnvelope({ repoUrl: fieldMessage("REQUIRED", language) }, language),
        400,
      );
    }

    const validated = validateCommittersBody(raw);
    if (!validated.ok) {
      return c.json(
        validationEnvelope(renderIssues(validated.issues, language), language),
        400,
      );
    }

    const { repoUrl, pat, branch, dateFrom, dateTo } = validated.value;
    const { allowPrivateHosts, timeZone, gitRunner, lookup, cloneTimeoutMs } =
      resolve();

    try {
      const committers = await withClone(
        {
          // Not a job id: nothing is persisted. It is a path segment under
          // `tempRoot()`, so the startup sweep still finds a stray.
          jobId: randomUUID(),
          repoUrl,
          ...(pat === undefined ? {} : { pat }),
          branch,
          allowPrivateHosts,
          timeoutMs: cloneTimeoutMs ?? INSPECT_CLONE_TIMEOUT_MS,
          ...(gitRunner === undefined ? {} : { runner: gitRunner }),
          ...(lookup === undefined ? {} : { lookup }),
        },
        async (clone) =>
          groupCommitters(
            await readCommits(clone.dir, {
              branch,
              dateFrom,
              dateTo,
              timeZone,
              includeDiffs: false,
              ...(gitRunner === undefined ? {} : { runner: gitRunner }),
            }),
          ),
      );
      return c.json({ committers }, 200);
    } catch (error) {
      return c.json(remoteFailure(error, language), 502);
    }
  });

  return repos;
}
