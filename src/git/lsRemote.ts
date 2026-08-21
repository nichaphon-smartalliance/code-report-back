/**
 * `git ls-remote` (TASK-017 §1, SPEC-003 Decision 1).
 *
 * The branch list is read **without cloning**: enumerating branch names is the
 * one repository question that has an answer over the wire, and a clone to
 * learn two hundred short names would cost minutes for a form field.
 *
 * The argv discipline is `buildCloneArgs`'s, unchanged — `credential.helper=`,
 * `core.askPass=`, and the PAT as an `http.extraHeader`, never in the URL
 * (SPEC-001 "PAT handling" 4). No directory is created on any path.
 *
 * Failure mapping is `classifyCloneFailure`, reused rather than re-derived: the
 * stderr shapes are the same ones, so this module adds **no error code**.
 */

import { authorizationHeader, classifyCloneFailure, credentialSecrets } from "./clone.ts";
import { GitLayerError } from "./errors.ts";
import { runGit, type GitRunner } from "./run.ts";
import { assertSafeRepoUrl, type HostLookup } from "./urlSafety.ts";

/**
 * 30 seconds, not the clone's ten minutes (SPEC-003 Decision 1): a form field
 * may not hang for a run's budget. The outcome is still `CLONE_TIMEOUT`.
 */
export const LS_REMOTE_TIMEOUT_MS = 30_000;

const HEADS_PREFIX = "refs/heads/";

export type RemoteBranches = {
  /** Short names, in git's own order. */
  branches: string[];
  /** HEAD's target, only when it is one of `branches`. Never invented. */
  defaultBranch: string | null;
};

export type ListRemoteBranchesOptions = {
  repoUrl: string;
  /** The request's PAT. Request-lifetime only, never persisted. */
  pat?: string | undefined;
  allowPrivateHosts: boolean;
  timeoutMs?: number | undefined;
  /** Test seams — never set in production, exactly as `cloneRepository` has them. */
  runner?: GitRunner | undefined;
  lookup?: HostLookup | undefined;
};

/**
 * The exact argv handed to `git`. Exported so a test can assert the token is in
 * the config header and nowhere near the remote URL.
 */
export function buildLsRemoteArgs(
  href: string,
  options: { pat?: string | undefined } = {},
): string[] {
  const args = ["-c", "credential.helper=", "-c", "core.askPass="];
  if (options.pat !== undefined) {
    args.push("-c", `http.extraHeader=${authorizationHeader(options.pat)}`);
  }
  args.push("ls-remote", "--symref", "--heads", href);
  return args;
}

/**
 * Parse `git ls-remote --symref --heads`:
 *
 * ```
 * ref: refs/heads/main	HEAD
 * <sha>	refs/heads/main
 * <sha>	refs/heads/develop
 * ```
 *
 * The symref line is not guaranteed to be there (a remote with no HEAD, and
 * some git versions filter it under `--heads`), so `defaultBranch` is `null`
 * unless its target is genuinely among the heads. Never fall back to `main`:
 * pre-selecting a branch that does not exist would hand the user a
 * `BRANCH_NOT_FOUND` run they did not ask for.
 */
export function parseLsRemote(stdout: string): RemoteBranches {
  const branches: string[] = [];
  let symrefTarget: string | undefined;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;

    if (trimmed.startsWith("ref: ")) {
      const [target, name] = trimmed.slice("ref: ".length).split(/\s+/);
      if (
        name === "HEAD" &&
        target !== undefined &&
        target.startsWith(HEADS_PREFIX)
      ) {
        symrefTarget = target.slice(HEADS_PREFIX.length);
      }
      continue;
    }

    const ref = trimmed.split(/\s+/)[1];
    if (ref === undefined || !ref.startsWith(HEADS_PREFIX)) continue;
    branches.push(ref.slice(HEADS_PREFIX.length));
  }

  return {
    branches,
    defaultBranch:
      symrefTarget !== undefined && branches.includes(symrefTarget)
        ? symrefTarget
        : null,
  };
}

/**
 * The remote's branches. Throws `GitLayerError` on failure and `RepoUrlError`
 * on an unsafe address — the same two the clone throws, so the caller maps
 * them the same way.
 *
 * An empty remote is a **success** with an empty list: whether the user may
 * continue from there is a screen rule (REQ-004 Requirement 1a), not an HTTP
 * one.
 */
export async function listRemoteBranches(
  options: ListRemoteBranchesOptions,
): Promise<RemoteBranches> {
  const url = await assertSafeRepoUrl(options.repoUrl, {
    allowPrivateHosts: options.allowPrivateHosts,
    lookup: options.lookup,
  });

  const runner = options.runner ?? runGit;
  const result = await runner(buildLsRemoteArgs(url.href, { pat: options.pat }), {
    timeoutMs: options.timeoutMs ?? LS_REMOTE_TIMEOUT_MS,
    secrets: credentialSecrets(options.pat),
  });

  if (result.timedOut) throw new GitLayerError("CLONE_TIMEOUT");
  if (result.exitCode !== 0) {
    throw classifyCloneFailure(result.stderr, {
      hasPat: options.pat !== undefined,
    });
  }

  return parseLsRemote(result.stdout);
}
