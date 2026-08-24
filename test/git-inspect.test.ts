/**
 * TASK-026 / SPEC-007 D5 — RepoInspector over a live clone.
 * Fixture repository in a temp dir; no network, no real remote.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import {
  BINARY_FILE_MARK,
  createRepoInspector,
  MAX_SEARCH_HITS,
  NOT_FOUND_MARK,
  OUTSIDE_REPO_MARK,
} from "../src/git/inspect.ts";
import { MAX_CHARS_PER_FILE, TRUNCATION_MARK } from "../src/git/markdown.ts";
import { MAX_TREE_PATHS } from "../src/git/tree.ts";
import type { GitRunner } from "../src/git/run.ts";
import { commitFiles, initRepo, makeTempDir, removeDir } from "./fixtures/gitRepo.ts";

const LONG_FILE = "x".repeat(MAX_CHARS_PER_FILE + 500);

const root = await makeTempDir();
const repo = join(root, "repo");
// A sibling of the clone root, to prove `..` cannot reach outside it.
const OUTSIDE = join(root, "outside-secret.txt");
await mkdir(repo, { recursive: true });
await writeFile(OUTSIDE, "TOP SECRET — must never be reachable\n", "utf8");
await initRepo(repo);
await commitFiles(repo, {
  message: "init",
  date: "2026-08-07T09:00:00+07:00",
  authorName: "Somchai Jaidee",
  authorEmail: "somchai@x.co.th",
  files: {
    ".gitignore": "node_modules/\n",
    "README.md": "# Fixture\nneedle_token appears here\n",
    "src/index.ts": "export const dashArg = '--flagish-literal';\n",
    "src/lib/util.ts": "export const b = needle_token;\n",
    "src/big.txt": LONG_FILE,
    // Untracked (gitignored) — proves git grep only reaches tracked files.
    "node_modules/lib/index.js": "module.exports = needle_token;\n",
  },
});

afterAll(async () => {
  await removeDir(root);
});

describe("listTree", () => {
  test("returns tracked, non-excluded paths from the real clone", async () => {
    const inspector = createRepoInspector(repo);
    const paths = await inspector.listTree();
    expect(paths).toContain("README.md");
    expect(paths).toContain("src/index.ts");
    expect(paths).not.toContain("node_modules/lib/index.js");
  }, 30_000);

  test("caps at MAX_TREE_PATHS (reuses the existing constant)", async () => {
    const many = Array.from({ length: MAX_TREE_PATHS + 50 }, (_u, i) => `f${i}.ts`);
    const runner: GitRunner = async () => ({
      exitCode: 0,
      stdout: many.join("\0"),
      stderr: "",
      timedOut: false,
    });
    const inspector = createRepoInspector("/unused", { runner });
    const paths = await inspector.listTree();
    expect(paths.length).toBe(MAX_TREE_PATHS);
  });
});

describe("readFile", () => {
  test("returns a file's contents", async () => {
    const inspector = createRepoInspector(repo);
    expect(await inspector.readFile("README.md")).toContain("needle_token");
  }, 30_000);

  test("caps a long file at MAX_CHARS_PER_FILE and marks it", async () => {
    const inspector = createRepoInspector(repo);
    const content = await inspector.readFile("src/big.txt");
    expect(content.length).toBe(MAX_CHARS_PER_FILE + TRUNCATION_MARK.length);
    expect(content.endsWith(TRUNCATION_MARK)).toBe(true);
  }, 30_000);

  test("rejects a `..` path that escapes the clone root", async () => {
    const inspector = createRepoInspector(repo);
    expect(await inspector.readFile("../outside-secret.txt")).toBe(OUTSIDE_REPO_MARK);
    expect(await inspector.readFile("src/../../outside-secret.txt")).toBe(
      OUTSIDE_REPO_MARK,
    );
  }, 30_000);

  test("rejects an absolute path", async () => {
    const inspector = createRepoInspector(repo);
    expect(await inspector.readFile(OUTSIDE)).toBe(OUTSIDE_REPO_MARK);
  }, 30_000);

  test("a missing file returns the not-found sentinel, not a throw", async () => {
    const inspector = createRepoInspector(repo);
    expect(await inspector.readFile("does/not/exist.ts")).toBe(NOT_FOUND_MARK);
  }, 30_000);

  test("a binary file (NUL byte) returns the binary sentinel", async () => {
    const inspector = createRepoInspector(repo, {
      readBytes: async () => new Uint8Array([0x41, 0x00, 0x42]),
    });
    expect(await inspector.readFile("README.md")).toBe(BINARY_FILE_MARK);
  }, 30_000);

  test("a symlink escaping the clone is rejected after resolution", async () => {
    const linkPath = join(repo, "escape-link");
    try {
      await symlink(OUTSIDE, linkPath);
    } catch {
      // Some platforms (Windows without privilege) forbid symlink creation;
      // the lexical `..`/absolute tests above already cover confinement there.
      return;
    }
    const inspector = createRepoInspector(repo);
    expect(await inspector.readFile("escape-link")).toBe(OUTSIDE_REPO_MARK);
  }, 30_000);
});

describe("search", () => {
  test("returns capped literal-match hits with path and line", async () => {
    const inspector = createRepoInspector(repo);
    const hits = await inspector.search("needle_token");
    const paths = hits.map((h) => h.path);
    expect(paths).toContain("README.md");
    expect(paths).toContain("src/lib/util.ts");
    // node_modules is untracked → git grep never sees it.
    expect(paths).not.toContain("node_modules/lib/index.js");
    for (const hit of hits) {
      expect(hit.line).toBeGreaterThan(0);
      expect(hit.text).toContain("needle_token");
    }
  }, 30_000);

  test("a leading-dash word is a literal, not a flag", async () => {
    const inspector = createRepoInspector(repo);
    const hits = await inspector.search("--flagish-literal");
    expect(hits.map((h) => h.path)).toContain("src/index.ts");
  }, 30_000);

  test("no matches returns an empty array (git grep exit 1 is not an error)", async () => {
    const inspector = createRepoInspector(repo);
    expect(await inspector.search("zzz_no_such_word_zzz")).toEqual([]);
  }, 30_000);

  test("caps the number of hits returned", async () => {
    const lines = Array.from({ length: MAX_SEARCH_HITS + 20 }, (_u, i) => `f.ts:${i + 1}:hit`);
    const runner: GitRunner = async () => ({
      exitCode: 0,
      stdout: lines.join("\n"),
      stderr: "",
      timedOut: false,
    });
    const inspector = createRepoInspector("/unused", { runner });
    const hits = await inspector.search("hit");
    expect(hits.length).toBe(MAX_SEARCH_HITS);
  });

  test("an empty word searches nothing", async () => {
    let called = false;
    const runner: GitRunner = async () => {
      called = true;
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };
    const inspector = createRepoInspector("/unused", { runner });
    expect(await inspector.search("")).toEqual([]);
    expect(called).toBe(false);
  });
});
