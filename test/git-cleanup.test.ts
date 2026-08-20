/**
 * TASK-003 §7 — temp-dir lifecycle. "A leftover clone of a private repo on disk
 * is a data leak", so cleanup must work on the throwing path too.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { jobTempDir, removeJobDir, sweepStaleTempDirs, tempRoot } from "../src/git/cleanup.ts";
import { makeTempDir, removeDir } from "./fixtures/gitRepo.ts";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("jobTempDir", () => {
  test("lives under one root so a sweep can find strays", () => {
    expect(jobTempDir("abc-123").startsWith(tempRoot())).toBe(true);
  });

  test("refuses a job id that is not a safe path segment", () => {
    expect(() => jobTempDir("../../etc")).toThrow();
    expect(() => jobTempDir("a/b")).toThrow();
    expect(() => jobTempDir("")).toThrow();
  });
});

describe("removeJobDir", () => {
  test("removes a populated directory", async () => {
    const root = await makeTempDir();
    const dir = join(root, "clone", "nested");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "file.txt"), "x", "utf8");
    await removeJobDir(join(root, "clone"));
    expect(await exists(join(root, "clone"))).toBe(false);
    await removeDir(root);
  });

  test("never throws on a directory that is not there", async () => {
    await removeJobDir(join(await makeTempDir(), "never-created"));
  });
});

describe("sweepStaleTempDirs", () => {
  test("removes only directories older than the age limit", async () => {
    const root = await makeTempDir();
    const fresh = join(root, "fresh");
    const stale = join(root, "stale");
    await mkdir(fresh, { recursive: true });
    await mkdir(stale, { recursive: true });
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await utimes(stale, old, old);

    const removed = await sweepStaleTempDirs({ root });
    expect(removed).toEqual([stale]);
    expect(await exists(stale)).toBe(false);
    expect(await exists(fresh)).toBe(true);
    await removeDir(root);
  });

  test("an empty temp root is not an error", async () => {
    expect(Array.isArray(await sweepStaleTempDirs())).toBe(true);
  });
});
