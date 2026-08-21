/**
 * Clone (TASK-003 §3, SPEC-001 worker step 1).
 *
 * The PAT never reaches the remote URL. It is passed as an
 * `http.extraHeader` config value on the argv array, because a URL-embedded
 * token is written into `.git/config` on disk and echoed by `git remote -v`
 * (SPEC-001 "Non-functional → PAT handling" 4).
 *
 * Both the raw token and the base64 credential derived from it are handed to
 * the redactor for every line of git output this module reads.
 */

import { GitLayerError } from "./errors.ts";
import { jobTempDir, removeJobDir } from "./cleanup.ts";
import { firstMeaningfulLine, runGit, type GitRunner } from "./run.ts";
import { assertSafeRepoUrl, type HostLookup } from "./urlSafety.ts";

/** SPEC-001 worker step 1: 10 minutes wall clock, then `CLONE_TIMEOUT`. */
export const CLONE_TIMEOUT_MS = 10 * 60 * 1000;

export type CloneOptions = {
  jobId: string;
  repoUrl: string;
  /** The run's PAT. Held by the caller for the run only, never persisted. */
  pat?: string;
  branch?: string;
  allowPrivateHosts: boolean;
  timeoutMs?: number;
  /** Test seams — never set in production. */
  runner?: GitRunner;
  lookup?: HostLookup;
  /** Overrides the temp location; defaults to `os.tmpdir()/code-report/<jobId>`. */
  dir?: string;
};

export type Clone = {
  dir: string;
  /** True when the user named a branch, so `git log` must use it. */
  branch: string | undefined;
};

/** `Authorization: Basic base64("x-access-token:<pat>")`, as SPEC-001 requires. */
export function authorizationHeader(pat: string): string {
  return `Authorization: Basic ${Buffer.from(`x-access-token:${pat}`, "utf8").toString("base64")}`;
}

/**
 * Everything derived from the token that is itself a secret. Exported for
 * TASK-017's `ls-remote`, which redacts the same three values — **a second
 * list of "what counts as a secret" is how one of them stops being redacted.**
 */
export function credentialSecrets(pat: string | undefined): (string | undefined)[] {
  if (pat === undefined) return [];
  const header = authorizationHeader(pat);
  // The base64 blob on its own decodes straight back to the token, so it is a
  // secret in its own right and is redacted literally, not by pattern.
  return [pat, header, header.slice("Authorization: Basic ".length)];
}

const BRANCH_MISSING = [
  /remote branch .+ not found in upstream/i,
  /could not find remote branch/i,
];

const AUTH_FAILED = [
  /authentication failed/i,
  /could not read username/i,
  /invalid username or password/i,
  /http basic: access denied/i,
  /terminal prompts disabled/i,
  /\b403\b/,
];

/**
 * The remote answered and it is not a repository — unambiguous, so it stays
 * `REPO_NOT_FOUND`.
 */
const NOT_A_REPOSITORY = [/does not appear to be a git repository/i];

/**
 * A 404 / "not found", which is genuinely ambiguous: a wrong address, a private
 * repository with no token, or a valid token whose scope does not cover it.
 * SPEC-001's error table files "token … insufficient" under `REPO_AUTH_FAILED`,
 * and only that message names both causes.
 */
const NOT_FOUND = [
  /repository .* not found/i,
  /\bnot found\b/i,
  /\b404\b/,
];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Map git's stderr onto SPEC-001's error table.
 *
 * The binding rule (SPEC-001 amended 2026-08-20, Q-BE-5): **a 404 ⇒
 * `REPO_AUTH_FAILED`, with or without a PAT** — GitHub answers 404 both for a
 * private repository with no token and for a valid token whose scope does not
 * cover it, and only `REPO_AUTH_FAILED`'s message names both causes.
 * `REPO_NOT_FOUND` stays for the unambiguous case where the remote answered and
 * it is not a repository.
 *
 * `options.hasPat` is kept because the caller has it and the two paths are one
 * amendment apart; nothing here branches on it today.
 */
export function classifyCloneFailure(
  stderr: string,
  options: { hasPat: boolean; branch?: string | undefined },
): GitLayerError {
  if (matchesAny(stderr, BRANCH_MISSING)) {
    return new GitLayerError("BRANCH_NOT_FOUND", { branch: options.branch });
  }
  if (matchesAny(stderr, AUTH_FAILED)) {
    return new GitLayerError("REPO_AUTH_FAILED");
  }
  if (matchesAny(stderr, NOT_A_REPOSITORY)) {
    return new GitLayerError("REPO_NOT_FOUND");
  }
  if (matchesAny(stderr, NOT_FOUND)) {
    return new GitLayerError("REPO_AUTH_FAILED");
  }
  return new GitLayerError("CLONE_FAILED", {
    detail: firstMeaningfulLine(stderr),
  });
}

/**
 * The exact argv handed to `git`. Exported so a test can assert the token is
 * in the config header and nowhere near the remote URL.
 */
export function buildCloneArgs(
  href: string,
  dir: string,
  options: { pat?: string | undefined; branch?: string | undefined } = {},
): string[] {
  const args = ["-c", "credential.helper=", "-c", "core.askPass="];
  if (options.pat !== undefined) {
    args.push("-c", `http.extraHeader=${authorizationHeader(options.pat)}`);
  }
  args.push("clone", "--filter=blob:none", "--single-branch");
  if (options.branch !== undefined) args.push("--branch", options.branch);
  args.push(href, dir);
  return args;
}

/** Clone into the job's temp directory. Throws `GitLayerError` on failure. */
export async function cloneRepository(options: CloneOptions): Promise<Clone> {
  const url = await assertSafeRepoUrl(options.repoUrl, {
    allowPrivateHosts: options.allowPrivateHosts,
    lookup: options.lookup,
  });

  const dir = options.dir ?? jobTempDir(options.jobId);
  const runner = options.runner ?? runGit;
  const secrets = credentialSecrets(options.pat);

  const args = buildCloneArgs(url.href, dir, {
    pat: options.pat,
    branch: options.branch,
  });

  const result = await runner(args, {
    timeoutMs: options.timeoutMs ?? CLONE_TIMEOUT_MS,
    secrets,
  });

  if (result.timedOut) {
    await removeJobDir(dir);
    throw new GitLayerError("CLONE_TIMEOUT");
  }

  if (result.exitCode !== 0) {
    await removeJobDir(dir);
    throw classifyCloneFailure(result.stderr, {
      hasPat: options.pat !== undefined,
      branch: options.branch,
    });
  }

  return { dir, branch: options.branch };
}

/**
 * Clone, hand the clone to `body`, and delete the temp directory in a
 * `finally` — on success, on throw, on timeout (SPEC-001 worker step 8).
 */
export async function withClone<T>(
  options: CloneOptions,
  body: (clone: Clone) => Promise<T>,
): Promise<T> {
  const clone = await cloneRepository(options);
  try {
    return await body(clone);
  } finally {
    await removeJobDir(clone.dir);
  }
}
