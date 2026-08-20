/**
 * A real git repository, built in a temp dir by the test setup.
 *
 * SPEC-001 "Testing": the git layer's unit tests must not touch the network,
 * so every test in this area runs against this fixture. Commit timestamps are
 * fixed and explicit — the Asia/Bangkok boundary case depends on them.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type FixtureCommit = {
  message: string;
  /** ISO-8601 with an explicit offset, e.g. `2026-08-07T23:30:00+07:00`. */
  date: string;
  authorName: string;
  authorEmail: string;
  /** path → contents. */
  files: Record<string, string>;
};

async function git(cwd: string, args: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`fixture: git ${args.join(" ")} failed: ${stderr}`);
  }
}

export async function makeTempDir(prefix = "code-report-test-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

async function writeFiles(dir: string, files: Record<string, string>) {
  for (const [path, contents] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, contents, "utf8");
  }
}

export async function initRepo(dir: string, branch = "main"): Promise<void> {
  await git(dir, ["init", "--quiet", `--initial-branch=${branch}`]);
  await git(dir, ["config", "user.name", "Fixture Bot"]);
  await git(dir, ["config", "user.email", "fixture@example.test"]);
  await git(dir, ["config", "commit.gpgsign", "false"]);
}

export async function commitFiles(
  dir: string,
  commit: FixtureCommit,
): Promise<void> {
  await writeFiles(dir, commit.files);
  await git(dir, ["add", "-A"]);
  await git(
    dir,
    [
      "-c",
      `user.name=${commit.authorName}`,
      "-c",
      `user.email=${commit.authorEmail}`,
      "commit",
      "--quiet",
      "--no-verify",
      "-m",
      commit.message,
    ],
    {
      GIT_AUTHOR_DATE: commit.date,
      GIT_COMMITTER_DATE: commit.date,
      GIT_AUTHOR_NAME: commit.authorName,
      GIT_AUTHOR_EMAIL: commit.authorEmail,
      GIT_COMMITTER_NAME: commit.authorName,
      GIT_COMMITTER_EMAIL: commit.authorEmail,
    },
  );
}

/** Create a branch, commit on it, and merge it back with a real merge commit. */
export async function mergeBranch(
  dir: string,
  options: { branch: string; commit: FixtureCommit; base?: string },
): Promise<void> {
  const base = options.base ?? "main";
  await git(dir, ["checkout", "--quiet", "-b", options.branch]);
  await commitFiles(dir, options.commit);
  await git(dir, ["checkout", "--quiet", base]);
  await git(
    dir,
    ["merge", "--quiet", "--no-ff", "-m", `merge ${options.branch}`, options.branch],
    {
      GIT_AUTHOR_DATE: options.commit.date,
      GIT_COMMITTER_DATE: options.commit.date,
    },
  );
}

export async function runGitRaw(dir: string, args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd: dir,
    env: { ...process.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  return stdout;
}
