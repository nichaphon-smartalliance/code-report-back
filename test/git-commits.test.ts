/**
 * TASK-003 §6 — the commit reader, against a real fixture repository built in a
 * temp dir. No network.
 *
 * The window used throughout is the single day **2026-08-07 in Asia/Bangkok**,
 * and the fixture deliberately puts one commit 30 minutes before its end and
 * one 30 minutes after — REQ-001 §4.5. Run this file with `TZ=UTC` and with
 * `TZ=Asia/Bangkok`: the result must be identical.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import {
  authorPattern,
  capDiff,
  commitLogArgs,
  MAX_DIFF_CHARS,
  MAX_FILES_FOR_DIFF,
  readCommits,
  windowBounds,
  zonedBoundary,
} from "../src/git/commits.ts";
import {
  commitFiles,
  initRepo,
  makeTempDir,
  mergeBranch,
  removeDir,
} from "./fixtures/gitRepo.ts";

const TZ = "Asia/Bangkok";
const DAY = { dateFrom: "2026-08-07", dateTo: "2026-08-07", timeZone: TZ };

const SOMCHAI = { authorName: "Somchai Jaidee", authorEmail: "somchai@x.co.th" };
const MALEE = { authorName: "Malee Wong", authorEmail: "malee@y.co.th" };
const NOK = { authorName: "Nok Srisai", authorEmail: "nok@z.co.th" };

/** 60 files > the 50-file threshold, so this commit contributes stats only. */
const MANY_FILES: Record<string, string> = {};
for (let index = 0; index < 60; index += 1) {
  MANY_FILES[`src/module-${String(index).padStart(2, "0")}.ts`] =
    `export const value${index} = ${index};\n`;
}

/** ~24 000 chars of changed lines, comfortably past the 8000-char diff cap. */
const HUGE_FILE = Array.from(
  { length: 600 },
  (_unused, line) => `export const line${line} = "${"x".repeat(30)}";`,
).join("\n");

const root = await makeTempDir();
const repo = join(root, "repo");
await mkdir(repo, { recursive: true });
await initRepo(repo);

await commitFiles(repo, {
  ...SOMCHAI,
  message: "chore: scaffold the project",
  date: "2026-08-06T10:00:00+07:00",
  files: { "README.md": "# fixture\n" },
});
await commitFiles(repo, {
  ...SOMCHAI,
  message: "feat: late evening work",
  date: "2026-08-07T23:30:00+07:00",
  files: { "src/late.ts": "export const late = true;\n" },
});
await commitFiles(repo, {
  ...MALEE,
  message: "feat: a wide refactor",
  date: "2026-08-07T12:00:00+07:00",
  files: MANY_FILES,
});
await commitFiles(repo, {
  ...SOMCHAI,
  message: "feat: generated bundle",
  date: "2026-08-07T13:00:00+07:00",
  files: { "src/huge.ts": HUGE_FILE },
});
await mergeBranch(repo, {
  branch: "feature/side",
  commit: {
    ...NOK,
    message: "feat: side branch work",
    date: "2026-08-07T14:00:00+07:00",
    files: { "src/side.ts": "export const side = 1;\n" },
  },
});
await commitFiles(repo, {
  ...MALEE,
  message: "fix: next morning",
  date: "2026-08-08T00:30:00+07:00",
  files: { "src/next.ts": "export const next = true;\n" },
});

afterAll(async () => {
  await removeDir(root);
});

function subjects(commits: { subject: string }[]): string[] {
  return commits.map((commit) => commit.subject).sort();
}

describe("day boundaries in REPORT_TIMEZONE", () => {
  test("a boundary carries the zone's offset, not the machine's", () => {
    expect(zonedBoundary("2026-08-07", "00:00:00.000", TZ)).toBe(
      "2026-08-07T00:00:00.000+07:00",
    );
    const { since, until } = windowBounds("2026-08-01", "2026-08-07", TZ);
    expect(since).toBe("2026-08-01T00:00:00.000+07:00");
    expect(until).toBe("2026-08-07T23:59:59.999+07:00");
  });

  test("the machine's TZ does not change the window", () => {
    // The function is pure and offset-explicit; process.env.TZ is never read.
    expect(zonedBoundary("2026-08-07", "23:59:59.999", "UTC")).toBe(
      "2026-08-07T23:59:59.999+00:00",
    );
    expect(zonedBoundary("2026-08-07", "23:59:59.999", TZ)).toBe(
      "2026-08-07T23:59:59.999+07:00",
    );
  });

  test("23:30 on the day is in, 00:30 the next day is out", async () => {
    const commits = await readCommits(repo, { ...DAY, includeDiffs: false });
    const found = subjects(commits);
    expect(found).toContain("feat: late evening work");
    expect(found).not.toContain("fix: next morning");
    expect(found).not.toContain("chore: scaffold the project");
  }, 30_000);
});

describe("filters", () => {
  test("merge commits are excluded", async () => {
    const commits = await readCommits(repo, { ...DAY, includeDiffs: false });
    expect(subjects(commits)).not.toContain("merge feature/side");
    expect(commitLogArgs(repo, DAY)).toContain("--no-merges");
  }, 30_000);

  test("author matches a case-insensitive substring of the name", async () => {
    const commits = await readCommits(repo, {
      ...DAY,
      author: "somCHAI",
      includeDiffs: false,
    });
    expect(commits.length).toBeGreaterThan(0);
    for (const commit of commits) expect(commit.authorName).toBe(SOMCHAI.authorName);
  }, 30_000);

  test("author matches a substring of the email", async () => {
    const commits = await readCommits(repo, {
      ...DAY,
      author: "@y.co.th",
      includeDiffs: false,
    });
    expect(commits.length).toBeGreaterThan(0);
    for (const commit of commits) expect(commit.authorEmail).toBe(MALEE.authorEmail);
  }, 30_000);

  test("author metacharacters are escaped, not interpreted", () => {
    expect(authorPattern("a.b+c(d)")).toBe("a\\.b\\+c\\(d\\)");
  });

  test("a branch that was never asked for is not passed to git", () => {
    expect(commitLogArgs(repo, DAY)).not.toContain("develop");
    expect(commitLogArgs(repo, { ...DAY, branch: "develop" })).toContain("develop");
  });
});

describe("commit contents", () => {
  test("metadata and numstat are parsed", async () => {
    const commits = await readCommits(repo, { ...DAY, includeDiffs: false });
    const late = commits.find((commit) => commit.subject === "feat: late evening work");
    expect(late).toBeDefined();
    expect(late?.authorEmail).toBe(SOMCHAI.authorEmail);
    expect(late?.shortSha.length).toBeGreaterThanOrEqual(7);
    expect(late?.sha.length).toBe(40);
    expect(late?.date).toMatch(/^2026-08-07T23:30:00\+07:00$/);
    expect(late?.files.map((file) => file.path)).toEqual(["src/late.ts"]);
    expect(late?.insertions).toBe(1);
  }, 30_000);

  test("a commit touching more than 50 files contributes stats only", async () => {
    const commits = await readCommits(repo, DAY);
    const wide = commits.find((commit) => commit.subject === "feat: a wide refactor");
    expect(wide?.files.length).toBeGreaterThan(MAX_FILES_FOR_DIFF);
    expect(wide?.diff).toBe("");
    expect(wide?.diffTruncated).toBe(true);
    expect(wide?.insertions).toBe(60);
  }, 60_000);

  test("a large diff is cut at 8000 chars and marked", async () => {
    const commits = await readCommits(repo, DAY);
    const huge = commits.find((commit) => commit.subject === "feat: generated bundle");
    expect(huge?.diffTruncated).toBe(true);
    expect(huge?.diff.startsWith("diff --git")).toBe(true);
    expect(huge?.diff.length).toBeLessThanOrEqual(MAX_DIFF_CHARS + 40);
    expect(huge?.diff).toContain("[truncated]");
  }, 60_000);

  test("capDiff leaves a small diff untouched", () => {
    expect(capDiff("small").truncated).toBe(false);
    expect(capDiff("small").diff).toBe("small");
  });

  test("an empty window is zero commits, not an error", async () => {
    const commits = await readCommits(repo, {
      dateFrom: "2026-01-01",
      dateTo: "2026-01-02",
      timeZone: TZ,
      includeDiffs: false,
    });
    expect(commits).toEqual([]);
  }, 30_000);
});
