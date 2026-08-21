/**
 * Body validation for the two repository-inspection endpoints (TASK-017 §2,
 * SPEC-003 "API / Interface Design").
 *
 * Nothing here is a new rule. The URL goes through the **same** `parseRepoUrl`
 * the report body uses (so a URL carrying userinfo is rejected here too), and
 * the date window goes through the **same** `applyDateWindowRules` — imported,
 * not re-implemented, because a second copy of the 366-day bound is how two
 * bounds drift apart.
 *
 * The `pat` is type-checked and nothing else: its content is the user's secret,
 * and no line of this module inspects, logs or echoes it.
 */

import { RepoUrlError, parseRepoUrl } from "../git/urlSafety.ts";
import {
  applyDateWindowRules,
  optionalText,
  requiredText,
  type FieldIssues,
} from "../reports/validate.ts";

export type BranchesBody = {
  repoUrl: string;
  pat: string | undefined;
};

export type CommittersBody = BranchesBody & {
  branch: string;
  dateFrom: string;
  dateTo: string;
};

export type RepoValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: FieldIssues };

/** `repoUrl` + `pat`, shared by both endpoints. */
function validateRepoTarget(
  body: Record<string, unknown>,
  issues: FieldIssues,
): { repoUrl: string | undefined; pat: string | undefined } {
  const repoUrl = requiredText(body.repoUrl, "repoUrl", issues);
  if (repoUrl !== undefined) {
    try {
      parseRepoUrl(repoUrl);
    } catch (error) {
      if (!(error instanceof RepoUrlError)) throw error;
      issues.repoUrl = { issue: "INVALID_URL" };
    }
  }
  return { repoUrl, pat: optionalText(body.pat, "pat", issues) };
}

function asObject(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  return raw as Record<string, unknown>;
}

export function validateBranchesBody(
  raw: unknown,
): RepoValidationResult<BranchesBody> {
  const body = asObject(raw);
  if (body === undefined) {
    return { ok: false, issues: { repoUrl: { issue: "REQUIRED" } } };
  }

  const issues: FieldIssues = {};
  const { repoUrl, pat } = validateRepoTarget(body, issues);
  if (Object.keys(issues).length > 0) return { ok: false, issues };

  return { ok: true, value: { repoUrl: repoUrl as string, pat } };
}

/**
 * `branch`, `dateFrom` and `dateTo` are **required** here — unlike `POST
 * /api/reports`, where `branch` is optional — because a committer list has no
 * meaning without the branch and window it was counted over (SPEC-003).
 */
export function validateCommittersBody(
  raw: unknown,
): RepoValidationResult<CommittersBody> {
  const body = asObject(raw);
  if (body === undefined) {
    return { ok: false, issues: { repoUrl: { issue: "REQUIRED" } } };
  }

  const issues: FieldIssues = {};
  const { repoUrl, pat } = validateRepoTarget(body, issues);
  const branch = requiredText(body.branch, "branch", issues);
  const dateFromText = requiredText(body.dateFrom, "dateFrom", issues);
  const dateToText = requiredText(body.dateTo, "dateTo", issues);

  applyDateWindowRules(dateFromText, dateToText, issues);

  if (Object.keys(issues).length > 0) return { ok: false, issues };

  return {
    ok: true,
    value: {
      repoUrl: repoUrl as string,
      pat,
      branch: branch as string,
      dateFrom: dateFromText as string,
      dateTo: dateToText as string,
    },
  };
}
