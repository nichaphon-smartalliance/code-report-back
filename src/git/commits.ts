/**
 * Commit reader (TASK-003 §6, SPEC-001 worker step 3).
 *
 * **Day boundaries are computed in `REPORT_TIMEZONE` (default `Asia/Bangkok`),
 * never the server's local zone** — REQ-001 §4.5 is a requirement, not a
 * default. The window handed to `git log` therefore always carries an explicit
 * offset, so the same run on a UTC server and on a Bangkok laptop selects the
 * same commits.
 */

import { GitLayerError } from "./errors.ts";
import { firstMeaningfulLine, runGit, type GitRunner } from "./run.ts";

/** A commit touching more than this contributes stats only, no diff body. */
export const MAX_FILES_FOR_DIFF = 50;
/** Per-commit diff cap (SPEC-001 worker step 3). */
export const MAX_DIFF_CHARS = 8000;
export const DIFF_TRUNCATION_MARK = "\n…[truncated]";

/**
 * ASCII unit (0x1f) and record (0x1e) separators. A commit body may contain
 * any printable text, so a printable delimiter is not safe; `%x1e`/`%x1f` tell
 * git to emit these bytes literally.
 */
const UNIT = "\u001f";
const RECORD = "\u001e";
const LOG_FORMAT =
  "%x1e%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%b%x1f";

export type ChangedFile = {
  path: string;
  insertions: number;
  deletions: number;
  /** git prints "-" for a binary file instead of a line count. */
  binary: boolean;
};

export type Commit = {
  sha: string;
  shortSha: string;
  authorName: string;
  authorEmail: string;
  /** ISO-8601 strict, in the commit's own author timezone (git's own value). */
  date: string;
  subject: string;
  body: string;
  files: ChangedFile[];
  insertions: number;
  deletions: number;
  diff: string;
  /** True when the diff was dropped or cut by one of the two caps. */
  diffTruncated: boolean;
};

/* ------------------------------------------------------------------ *
 * Timezone-correct day boundaries
 * ------------------------------------------------------------------ */

/** Minutes east of UTC for `timeZone` at `instant` (DST-aware). */
export function zoneOffsetMinutes(timeZone: string, instant: Date): number {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  }).format(instant);
  const found = formatted.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (found === null) return 0; // "GMT" with no offset means UTC
  const sign = found[1] === "-" ? -1 : 1;
  return sign * (Number(found[2]) * 60 + Number(found[3]));
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const rest = String(absolute % 60).padStart(2, "0");
  return `${sign}${hours}:${rest}`;
}

/**
 * `2026-08-07` + `00:00:00.000` in `Asia/Bangkok` → `2026-08-07T00:00:00.000+07:00`.
 *
 * Two passes so that a zone with DST is resolved at the *local* instant rather
 * than at the UTC one — Asia/Bangkok has no DST, but `REPORT_TIMEZONE` is
 * configurable and the next operator's zone may.
 */
export function zonedBoundary(
  date: string,
  time: string,
  timeZone: string,
): string {
  const naive = Date.parse(`${date}T${time}Z`);
  if (Number.isNaN(naive)) {
    throw new Error(`Invalid date "${date}" for the report window.`);
  }
  const first = zoneOffsetMinutes(timeZone, new Date(naive));
  const second = zoneOffsetMinutes(timeZone, new Date(naive - first * 60_000));
  return `${date}T${time}${formatOffset(second)}`;
}

export function windowBounds(
  dateFrom: string,
  dateTo: string,
  timeZone: string,
): { since: string; until: string } {
  return {
    since: zonedBoundary(dateFrom, "00:00:00.000", timeZone),
    until: zonedBoundary(dateTo, "23:59:59.999", timeZone),
  };
}

/* ------------------------------------------------------------------ *
 * Author filter
 * ------------------------------------------------------------------ */

/**
 * The user's free text (REQ-001 §4.6), trimmed and **not** escaped.
 *
 * git matches `--author` as a POSIX *basic* regex by default, where `+ ? { } ( )
 * |` are literal until backslashed — so escaping them the JavaScript way turns
 * plain text into operators and matches the wrong commits (a user filtering by
 * `somchai+dev@x.co.th` was returned `somchaidev@x.co.th`'s commits and none of
 * their own). `commitLogArgs` passes `-F`/`--fixed-strings` instead, so free
 * text is compared as free text and never compiled as a pattern.
 */
export function authorNeedle(author: string): string {
  return author.trim();
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

function parseNumstat(block: string): {
  files: ChangedFile[];
  insertions: number;
  deletions: number;
} {
  const files: ChangedFile[] = [];
  let insertions = 0;
  let deletions = 0;

  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const parts = trimmed.split("\t");
    if (parts.length < 3) continue;
    const [added = "", removed = "", ...rest] = parts;
    const path = rest.join("\t");
    const binary = added === "-" || removed === "-";
    const addedCount = binary ? 0 : Number(added);
    const removedCount = binary ? 0 : Number(removed);
    if (Number.isNaN(addedCount) || Number.isNaN(removedCount)) continue;
    files.push({ path, insertions: addedCount, deletions: removedCount, binary });
    insertions += addedCount;
    deletions += removedCount;
  }

  return { files, insertions, deletions };
}

export function parseCommitLog(stdout: string): Commit[] {
  const commits: Commit[] = [];

  for (const chunk of stdout.split(RECORD)) {
    if (chunk.trim() === "") continue;
    const fields = chunk.split(UNIT);
    if (fields.length < 7) continue;
    const [sha = "", shortSha = "", authorName = "", authorEmail = "", date = "", subject = "", body = ""] =
      fields;
    const numstat = parseNumstat(fields.slice(7).join(UNIT));

    commits.push({
      sha,
      shortSha,
      authorName,
      authorEmail,
      date,
      subject,
      body: body.trim(),
      files: numstat.files,
      insertions: numstat.insertions,
      deletions: numstat.deletions,
      diff: "",
      diffTruncated: false,
    });
  }

  return commits;
}

export type ReadCommitsOptions = {
  branch?: string;
  dateFrom: string;
  dateTo: string;
  author?: string;
  timeZone: string;
  /** Set false to skip `git show` entirely (metadata-only callers). */
  includeDiffs?: boolean;
  runner?: GitRunner;
};

export function commitLogArgs(
  dir: string,
  options: ReadCommitsOptions,
): string[] {
  const { since, until } = windowBounds(
    options.dateFrom,
    options.dateTo,
    options.timeZone,
  );
  const args = ["-C", dir, "log"];
  if (options.branch !== undefined) args.push(options.branch);
  args.push(`--since=${since}`, `--until=${until}`);
  if (options.author !== undefined && options.author.trim() !== "") {
    args.push(
      "--fixed-strings",
      `--author=${authorNeedle(options.author)}`,
      "--regexp-ignore-case",
    );
  }
  args.push("--no-merges", "--numstat", "--date=iso-strict", `--format=${LOG_FORMAT}`);
  return args;
}

/** `git show` for one commit, with generated files excluded from the diff. */
export function commitDiffArgs(dir: string, sha: string): string[] {
  return [
    "-C",
    dir,
    "show",
    "--format=",
    "--unified=3",
    sha,
    "--",
    ".",
    ":(exclude)*.lock",
    ":(exclude)package-lock.json",
    ":(exclude)*.min.*",
  ];
}

export function capDiff(diff: string): { diff: string; truncated: boolean } {
  if (diff.length <= MAX_DIFF_CHARS) return { diff, truncated: false };
  return {
    diff: diff.slice(0, MAX_DIFF_CHARS) + DIFF_TRUNCATION_MARK,
    truncated: true,
  };
}

/** git's way of saying the revision it was handed does not exist. */
const UNKNOWN_REVISION = [
  /unknown revision or path not in the working tree/i,
  /ambiguous argument/i,
  /bad revision/i,
];

/**
 * Map a non-zero `git log` onto SPEC-001's error table.
 *
 * This must never come back as an empty commit list: zero commits is
 * `NO_COMMITS`, which SPEC-001 defines as a **success**, so a git failure
 * returning `[]` would reach the user as a finished report saying no work was
 * done that day — indistinguishable from a true result.
 */
export function classifyLogFailure(
  stderr: string,
  options: { branch?: string | undefined },
): GitLayerError {
  if (
    options.branch !== undefined &&
    UNKNOWN_REVISION.some((pattern) => pattern.test(stderr))
  ) {
    return new GitLayerError("BRANCH_NOT_FOUND", { branch: options.branch });
  }
  // SPEC-001's "any other git failure". The stderr has already been through
  // runGit's redactor, so the detail is safe to store and show.
  return new GitLayerError("CLONE_FAILED", {
    detail: firstMeaningfulLine(stderr),
  });
}

/**
 * The commits in scope, newest first (git's own order), each with its capped
 * diff. Zero commits is a legitimate result, not an error — SPEC-001 turns it
 * into the `NO_COMMITS` status one layer up. A *failed* `git log`, by contrast,
 * throws (see `classifyLogFailure`).
 */
export async function readCommits(
  dir: string,
  options: ReadCommitsOptions,
): Promise<Commit[]> {
  const runner = options.runner ?? runGit;
  const log = await runner(commitLogArgs(dir, options));
  if (log.exitCode !== 0) {
    throw classifyLogFailure(log.stderr, { branch: options.branch });
  }

  const commits = parseCommitLog(log.stdout);
  if (options.includeDiffs === false) return commits;

  for (const commit of commits) {
    if (commit.files.length > MAX_FILES_FOR_DIFF) {
      // Stats only: a 200-file commit's diff would swamp the AI prompt and
      // tell it less than the numstat already does.
      commit.diffTruncated = true;
      continue;
    }
    const shown = await runner(commitDiffArgs(dir, commit.sha));
    if (shown.exitCode !== 0) continue;
    const capped = capDiff(shown.stdout);
    commit.diff = capped.diff;
    commit.diffTruncated = capped.truncated;
  }

  return commits;
}
