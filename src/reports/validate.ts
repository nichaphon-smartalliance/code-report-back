/**
 * `POST /api/reports` body validation (TASK-005 §1, SPEC-001 "API → Reports").
 *
 * Synchronous and DNS-free on purpose: the scheme gate (`git@`, `ssh://`,
 * `file://`) is a property of the string the user typed and belongs to the
 * 400; the address gate needs a name resolution and belongs to the run.
 *
 * Two bounds are pinned exactly by TASK-005 §1, because the frontend already
 * ships a check against each and **client validation must never reject what
 * the server would accept**:
 *
 *   - the span is the **exclusive** difference — 366 days is accepted, 367 is
 *     rejected, and a single day is a span of 0;
 *   - `extraContext` is counted in **UTF-16 code units** (`String.length`),
 *     not codepoints and not bytes, because the frontend's live counter is
 *     `.length`. Counting codepoints here would accept input the client
 *     refuses to send — the same failure in the opposite direction.
 */

import { RepoUrlError, parseRepoUrl } from "../git/urlSafety.ts";
import { isLanguage, type Language, type ValidationIssue } from "../errors/messages.ts";

export const MAX_EXTRA_CONTEXT_CHARS = 8000;
export const MAX_SPAN_DAYS = 366;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type CreateReportBody = {
  repoUrl: string;
  pat: string | undefined;
  branch: string | undefined;
  author: string | undefined;
  dateFrom: string;
  dateTo: string;
  extraContext: string | undefined;
  language: Language;
};

/** field name → the issue to render for it. */
export type FieldIssues = Record<string, { issue: ValidationIssue; limit?: number }>;

export type ValidationResult =
  | { ok: true; value: CreateReportBody }
  | { ok: false; issues: FieldIssues };

/** `YYYY-MM-DD`, and a real calendar day — `2026-02-31` is not one. */
export function parseCalendarDate(value: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const milliseconds = Date.parse(`${value}T00:00:00.000Z`);
  if (Number.isNaN(milliseconds)) return undefined;
  // Date.parse accepts 2026-02-31 in some engines by rolling over; compare the
  // round trip so a rolled-over date is rejected rather than silently moved.
  if (new Date(milliseconds).toISOString().slice(0, 10) !== value) return undefined;
  return milliseconds;
}

/** An optional free-text field: absent, or a non-empty trimmed string. */
function optionalText(
  raw: unknown,
  field: string,
  issues: FieldIssues,
): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    issues[field] = { issue: "INVALID_TYPE" };
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

function requiredText(
  raw: unknown,
  field: string,
  issues: FieldIssues,
): string | undefined {
  if (typeof raw !== "string") {
    issues[field] = { issue: raw === undefined ? "REQUIRED" : "INVALID_TYPE" };
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    issues[field] = { issue: "REQUIRED" };
    return undefined;
  }
  return trimmed;
}

export function validateCreateReport(raw: unknown): ValidationResult {
  const issues: FieldIssues = {};
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, issues: { repoUrl: { issue: "REQUIRED" } } };
  }
  const body = raw as Record<string, unknown>;

  const repoUrl = requiredText(body.repoUrl, "repoUrl", issues);
  if (repoUrl !== undefined) {
    try {
      parseRepoUrl(repoUrl);
    } catch (error) {
      if (!(error instanceof RepoUrlError)) throw error;
      issues.repoUrl = { issue: "INVALID_URL" };
    }
  }

  // The PAT is validated for type only: its content is the user's secret and
  // nothing here may inspect, log or echo it.
  const pat = optionalText(body.pat, "pat", issues);
  const branch = optionalText(body.branch, "branch", issues);
  const author = optionalText(body.author, "author", issues);

  const dateFromText = requiredText(body.dateFrom, "dateFrom", issues);
  const dateToText = requiredText(body.dateTo, "dateTo", issues);

  let from: number | undefined;
  let to: number | undefined;
  if (dateFromText !== undefined) {
    from = parseCalendarDate(dateFromText);
    if (from === undefined) issues.dateFrom = { issue: "INVALID_DATE" };
  }
  if (dateToText !== undefined) {
    to = parseCalendarDate(dateToText);
    if (to === undefined) issues.dateTo = { issue: "INVALID_DATE" };
  }
  if (from !== undefined && to !== undefined) {
    if (to < from) {
      issues.dateTo = { issue: "DATE_ORDER" };
    } else if ((to - from) / MS_PER_DAY > MAX_SPAN_DAYS) {
      issues.dateTo = { issue: "SPAN_TOO_LONG", limit: MAX_SPAN_DAYS };
    }
  }

  let language: Language | undefined;
  if (body.language === undefined) {
    issues.language = { issue: "REQUIRED" };
  } else if (typeof body.language !== "string" || !isLanguage(body.language)) {
    issues.language = { issue: "INVALID_LANGUAGE" };
  } else {
    language = body.language;
  }

  let extraContext: string | undefined;
  if (body.extraContext !== undefined && body.extraContext !== null) {
    if (typeof body.extraContext !== "string") {
      issues.extraContext = { issue: "INVALID_TYPE" };
    } else if (body.extraContext.length > MAX_EXTRA_CONTEXT_CHARS) {
      // `.length` — UTF-16 code units, matching the frontend's counter.
      issues.extraContext = {
        issue: "TOO_LONG",
        limit: MAX_EXTRA_CONTEXT_CHARS,
      };
    } else if (body.extraContext.trim() !== "") {
      extraContext = body.extraContext;
    }
  }

  if (Object.keys(issues).length > 0) return { ok: false, issues };

  return {
    ok: true,
    value: {
      repoUrl: repoUrl as string,
      pat,
      branch,
      author,
      dateFrom: dateFromText as string,
      dateTo: dateToText as string,
      extraContext,
      language: language as Language,
    },
  };
}
