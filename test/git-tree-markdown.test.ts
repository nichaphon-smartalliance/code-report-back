/**
 * TASK-003 §4/§5 — file tree and markdown digest, with their caps.
 * Fixture repository in a temp dir; no network.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import {
  capPaths,
  isExcludedPath,
  listRepoFiles,
  readFileTree,
} from "../src/git/tree.ts";
import {
  MAX_CHARS_PER_FILE,
  MAX_MARKDOWN_FILES,
  MAX_TOTAL_CHARS,
  orderMarkdownPaths,
  readMarkdownDigest,
  TRUNCATION_MARK,
} from "../src/git/markdown.ts";
import type { GitRunner } from "../src/git/run.ts";
import { commitFiles, initRepo, makeTempDir, removeDir } from "./fixtures/gitRepo.ts";

const LONG_README = `# Fixture\n${"readme body. ".repeat(3000)}`;

const root = await makeTempDir();
const repo = join(root, "repo");
await mkdir(repo, { recursive: true });
await initRepo(repo);
await commitFiles(repo, {
  message: "init",
  date: "2026-08-07T09:00:00+07:00",
  authorName: "Somchai Jaidee",
  authorEmail: "somchai@x.co.th",
  files: {
    "README.md": LONG_README,
    "CHANGELOG.md": "# changes\n",
    "docs/guide.md": "# guide\n",
    "docs/deep/a/b/c.md": "# deep\n",
    "src/index.ts": "export const a = 1;\n",
    "src/lib/util.ts": "export const b = 2;\n",
    "node_modules/lib/index.js": "module.exports = 1;\n",
    "dist/bundle.js": "console.log(1);\n",
    "vendor/thing.php": "<?php\n",
    "package-lock.json": "{}\n",
    "assets/logo.png": "not really a png\n",
    "assets/font.woff2": "not really a font\n",
  },
});

afterAll(async () => {
  await removeDir(root);
});

describe("exclusions", () => {
  test("generated directories, lockfiles and binaries are excluded", () => {
    expect(isExcludedPath("node_modules/lib/index.js")).toBe(true);
    expect(isExcludedPath("dist/bundle.js")).toBe(true);
    expect(isExcludedPath("build/out.js")).toBe(true);
    expect(isExcludedPath(".next/static/x.js")).toBe(true);
    expect(isExcludedPath("vendor/thing.php")).toBe(true);
    expect(isExcludedPath("package-lock.json")).toBe(true);
    expect(isExcludedPath("bun.lockb")).toBe(true);
    expect(isExcludedPath("assets/logo.png")).toBe(true);
    expect(isExcludedPath("assets/font.woff2")).toBe(true);
    expect(isExcludedPath("src/index.ts")).toBe(false);
    expect(isExcludedPath("README.md")).toBe(false);
  });

  test("the tree from a real repo drops them all", async () => {
    const files = await listRepoFiles(repo);
    expect(files).toContain("src/index.ts");
    expect(files).toContain("README.md");
    for (const excluded of [
      "node_modules/lib/index.js",
      "dist/bundle.js",
      "vendor/thing.php",
      "package-lock.json",
      "assets/logo.png",
    ]) {
      expect(files).not.toContain(excluded);
    }
  }, 30_000);
});

describe("tree cap", () => {
  test("keeps the shallowest paths", () => {
    const paths = ["a/b/c/d.ts", "top.ts", "a/b.ts", "a/b/c.ts"];
    expect(capPaths(paths, 2)).toEqual(["a/b.ts", "top.ts"]);
  });

  test("under the cap nothing is dropped or reordered", () => {
    const paths = ["a.ts", "b/c.ts"];
    expect(capPaths(paths, 10)).toEqual(paths);
  });

  test("readFileTree reports what it omitted", async () => {
    const tree = await readFileTree(repo, { limit: 3 });
    expect(tree.paths.length).toBe(3);
    expect(tree.omitted).toBeGreaterThan(0);
  }, 30_000);
});

describe("markdown digest", () => {
  test("root README first, then docs, then the rest by depth", () => {
    expect(
      orderMarkdownPaths([
        "src/notes.md",
        "docs/deep/a/b/c.md",
        "CHANGELOG.md",
        "docs/guide.md",
        "README.md",
        "src/index.ts",
      ]),
    ).toEqual([
      "README.md",
      "docs/guide.md",
      "docs/deep/a/b/c.md",
      "CHANGELOG.md",
      "src/notes.md",
    ]);
  });

  test("reads the repository's markdown in that order", async () => {
    const digest = await readMarkdownDigest(repo);
    expect(digest.files.map((file) => file.path)).toEqual([
      "README.md",
      "docs/guide.md",
      "docs/deep/a/b/c.md",
      "CHANGELOG.md",
    ]);
  }, 30_000);

  test("a long file is cut at 20 000 chars and marked inline", async () => {
    const digest = await readMarkdownDigest(repo);
    const readme = digest.files[0];
    expect(readme?.truncated).toBe(true);
    expect(readme?.content.length).toBe(MAX_CHARS_PER_FILE + TRUNCATION_MARK.length);
    expect(readme?.content.endsWith(TRUNCATION_MARK)).toBe(true);
  }, 30_000);

  test("caps at 40 files and 200 000 chars in total", async () => {
    // A stub repository: 50 markdown files of 20 000 chars each.
    const paths = Array.from({ length: 50 }, (_unused, index) => `doc-${index}.md`);
    const runner: GitRunner = async () => ({
      exitCode: 0,
      stdout: paths.join("\0"),
      stderr: "",
      timedOut: false,
    });
    const digest = await readMarkdownDigest("/unused", {
      runner,
      readTextFile: async () => "y".repeat(7000),
    });
    // 28 whole files fit in the 200 000-char budget; the 29th is cut to the
    // remaining 4 000 and marked, and the rest never open.
    expect(digest.files.length).toBe(29);
    expect(digest.files.length).toBeLessThanOrEqual(MAX_MARKDOWN_FILES);
    expect(digest.totalChars).toBe(MAX_TOTAL_CHARS);
    expect(digest.omittedFiles).toBe(21);
    const last = digest.files[digest.files.length - 1];
    expect(last?.truncated).toBe(true);
    expect(last?.content.endsWith(TRUNCATION_MARK)).toBe(true);
  });

  test("the 40-file cap bites before the character budget when files are small", async () => {
    const paths = Array.from({ length: 50 }, (_unused, index) => `doc-${index}.md`);
    const runner: GitRunner = async () => ({
      exitCode: 0,
      stdout: paths.join("\0"),
      stderr: "",
      timedOut: false,
    });
    const digest = await readMarkdownDigest("/unused", {
      runner,
      readTextFile: async () => "y".repeat(100),
    });
    expect(digest.files.length).toBe(MAX_MARKDOWN_FILES);
    expect(digest.omittedFiles).toBe(10);
  });
});
