/**
 * TASK-003 — clone argv, the SPEC-001 error table, and the DoD assertion that
 * a cloned repo's `.git/config` contains no token.
 *
 * The failure-mapping tests use a fake runner; the `.git/config` test performs
 * a real clone of a local fixture remote, with a dummy token supplied.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  authorizationHeader,
  buildCloneArgs,
  classifyCloneFailure,
  cloneRepository,
  withClone,
} from "../src/git/clone.ts";
import { GitLayerError } from "../src/git/errors.ts";
import type { GitRun, GitRunner } from "../src/git/run.ts";
import { runGit } from "../src/git/run.ts";
import type { HostLookup } from "../src/git/urlSafety.ts";
import { commitFiles, initRepo, makeTempDir, removeDir, runGitRaw } from "./fixtures/gitRepo.ts";
import { mkdir } from "node:fs/promises";

const DUMMY_PAT = "ghp_0123456789abcdefghijklmnopqrstuvwx";
const PUBLIC_LOOKUP: HostLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const REPO_URL = "https://example.com/team/app.git";

const tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await makeTempDir();
  tempDirs.push(dir);
  return dir;
}
afterAll(async () => {
  for (const dir of tempDirs) await removeDir(dir);
});

function fakeRunner(result: Partial<GitRun>, seen?: string[][]): GitRunner {
  return async (args) => {
    seen?.push(args);
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...result };
  };
}

describe("buildCloneArgs", () => {
  test("puts the token in an extraHeader and never in the URL", () => {
    const args = buildCloneArgs(REPO_URL, "/tmp/x", { pat: DUMMY_PAT });
    expect(args).toContain(`http.extraHeader=${authorizationHeader(DUMMY_PAT)}`);
    const url = args[args.length - 2];
    expect(url).toBe(REPO_URL);
    expect(url).not.toContain(DUMMY_PAT);
    expect(url).not.toContain("@");
  });

  test("carries the SPEC-001 clone flags and the branch when asked", () => {
    const args = buildCloneArgs(REPO_URL, "/tmp/x", { branch: "develop" });
    expect(args.slice(0, 4)).toEqual(["-c", "credential.helper=", "-c", "core.askPass="]);
    expect(args).toContain("--filter=blob:none");
    expect(args).toContain("--single-branch");
    expect(args.join(" ")).toContain("--branch develop");
  });

  test("no token supplied means no extraHeader at all", () => {
    const args = buildCloneArgs(REPO_URL, "/tmp/x");
    expect(args.join(" ")).not.toContain("extraHeader");
  });
});

describe("classifyCloneFailure — SPEC-001 error table", () => {
  test("a missing branch is BRANCH_NOT_FOUND", () => {
    const error = classifyCloneFailure(
      "fatal: Remote branch nope not found in upstream origin",
      { hasPat: true, branch: "nope" },
    );
    expect(error.code).toBe("BRANCH_NOT_FOUND");
    expect(error.branch).toBe("nope");
  });

  test("an authentication failure is REPO_AUTH_FAILED", () => {
    expect(
      classifyCloneFailure("remote: Invalid username or password", { hasPat: true })
        .code,
    ).toBe("REPO_AUTH_FAILED");
  });

  test("no PAT + a 404 is REPO_AUTH_FAILED, not REPO_NOT_FOUND", () => {
    // The binding rule: GitHub answers 404 for a private repository, and
    // "not found" would send the user looking for a typo that is not there.
    expect(
      classifyCloneFailure("remote: Repository not found.", { hasPat: false }).code,
    ).toBe("REPO_AUTH_FAILED");
  });

  test("a PAT was supplied and the remote 404s ⇒ REPO_AUTH_FAILED too", () => {
    // REWORK 4 / Q-BE-5: a valid token whose scope does not cover the repo also
    // 404s, and SPEC-001's table files "token … insufficient" under
    // REPO_AUTH_FAILED — only that message names both causes.
    expect(
      classifyCloneFailure("remote: Repository not found.", { hasPat: true }).code,
    ).toBe("REPO_AUTH_FAILED");
  });

  test("'does not appear to be a git repository' stays REPO_NOT_FOUND", () => {
    // The unambiguous case: the remote answered, and it is not a repository.
    for (const hasPat of [true, false]) {
      expect(
        classifyCloneFailure(
          "fatal: repository 'https://example.com/x/' does not appear to be a git repository",
          { hasPat },
        ).code,
      ).toBe("REPO_NOT_FOUND");
    }
  });

  test("anything else is CLONE_FAILED with the first meaningful line", () => {
    // The stderr reaching this function has already passed through runGit's
    // redactor, so the detail is safe to store and show.
    const error = classifyCloneFailure(
      "\n\nfatal: unable to access: SSL certificate problem\nmore noise\n",
      { hasPat: true },
    );
    expect(error.code).toBe("CLONE_FAILED");
    expect(error.detail).toBe("fatal: unable to access: SSL certificate problem");
  });
});

describe("cloneRepository", () => {
  test("a timeout becomes CLONE_TIMEOUT", async () => {
    const dir = join(await tempDir(), "clone");
    const promise = cloneRepository({
      jobId: "job-1",
      repoUrl: REPO_URL,
      dir,
      allowPrivateHosts: false,
      lookup: PUBLIC_LOOKUP,
      runner: fakeRunner({ exitCode: 143, timedOut: true }),
    });
    await expect(promise).rejects.toMatchObject({ code: "CLONE_TIMEOUT" });
  });

  test("an unsafe URL is refused before git is ever started", async () => {
    let started = false;
    const promise = cloneRepository({
      jobId: "job-2",
      repoUrl: "file:///etc/passwd",
      allowPrivateHosts: false,
      lookup: PUBLIC_LOOKUP,
      runner: async () => {
        started = true;
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      },
    });
    await expect(promise).rejects.toThrow();
    expect(started).toBe(false);
  });

  test("withClone deletes the temp dir after a successful run", async () => {
    const root = await tempDir();
    const dir = join(root, "clone-ok");
    const value = await withClone(
      {
        jobId: "job-3",
        repoUrl: REPO_URL,
        dir,
        allowPrivateHosts: false,
        lookup: PUBLIC_LOOKUP,
        runner: async () => {
          await mkdir(dir, { recursive: true });
          return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
        },
      },
      async () => "done",
    );
    expect(value).toBe("done");
    expect(await Bun.file(join(dir, "anything")).exists()).toBe(false);
    expect(await directoryExists(dir)).toBe(false);
  });

  test("withClone deletes the temp dir when the body throws", async () => {
    const root = await tempDir();
    const dir = join(root, "clone-throw");
    const promise = withClone(
      {
        jobId: "job-4",
        repoUrl: REPO_URL,
        dir,
        allowPrivateHosts: false,
        lookup: PUBLIC_LOOKUP,
        runner: async () => {
          await mkdir(dir, { recursive: true });
          return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
        },
      },
      async () => {
        throw new GitLayerError("INTERNAL");
      },
    );
    await expect(promise).rejects.toBeInstanceOf(GitLayerError);
    expect(await directoryExists(dir)).toBe(false);
  });

  test("a failed clone leaves nothing behind either", async () => {
    const root = await tempDir();
    const dir = join(root, "clone-fail");
    const promise = cloneRepository({
      jobId: "job-5",
      repoUrl: REPO_URL,
      dir,
      allowPrivateHosts: false,
      lookup: PUBLIC_LOOKUP,
      runner: async () => {
        await mkdir(dir, { recursive: true });
        return {
          exitCode: 128,
          stdout: "",
          stderr: "remote: Repository not found.",
          timedOut: false,
        };
      },
    });
    await expect(promise).rejects.toMatchObject({ code: "REPO_AUTH_FAILED" });
    expect(await directoryExists(dir)).toBe(false);
  });
});

describe("a real clone with a dummy token", () => {
  test("the cloned .git/config and remotes contain no token", async () => {
    const root = await tempDir();
    const source = join(root, "source");
    await mkdir(source, { recursive: true });
    await initRepo(source);
    await commitFiles(source, {
      message: "init",
      date: "2026-08-07T10:00:00+07:00",
      authorName: "Somchai Jaidee",
      authorEmail: "somchai@x.co.th",
      files: { "README.md": "# fixture\n" },
    });

    const target = join(root, "clone");
    const result = await runGit(
      buildCloneArgs(source, target, { pat: DUMMY_PAT }),
      { secrets: [DUMMY_PAT] },
    );
    expect(result.exitCode).toBe(0);

    const config = await readFile(join(target, ".git", "config"), "utf8");
    expect(config).not.toContain(DUMMY_PAT);
    expect(config).not.toContain("extraHeader");

    const remotes = await runGitRaw(target, ["remote", "-v"]);
    expect(remotes).not.toContain(DUMMY_PAT);
  }, 60_000);
});

async function directoryExists(dir: string): Promise<boolean> {
  try {
    const { stat } = await import("node:fs/promises");
    await stat(dir);
    return true;
  } catch {
    return false;
  }
}
