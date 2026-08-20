/**
 * Temp-dir lifecycle (TASK-003 §7, SPEC-001 worker step 8).
 *
 * "A leftover clone of a private repository on disk is a data leak", so
 * `removeJobDir` is written to be safe to call from a `finally` on every path —
 * success, throw, timeout — and never to throw itself.
 */

import { readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** All clones live under one root so a startup sweep can find strays. */
export function tempRoot(): string {
  return join(tmpdir(), "code-report");
}

/**
 * A job id comes from our own database, but it still becomes a path segment,
 * so it is validated rather than trusted.
 */
export function jobTempDir(jobId: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(jobId)) {
    throw new Error("Invalid job id for a temp directory.");
  }
  return join(tempRoot(), jobId);
}

/** Delete a job's clone. Never throws — cleanup must not mask the real error. */
export async function removeJobDir(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    /* a directory we could not delete is a log line, not a failed run */
  }
}

/**
 * Startup sweep (SPEC-001 "Limits"): remove clones older than `maxAgeMs` left
 * behind by a crash. Returns the directories removed, for the startup log line.
 */
export async function sweepStaleTempDirs(
  options: { maxAgeMs?: number; now?: number; root?: string } = {},
): Promise<string[]> {
  const maxAgeMs = options.maxAgeMs ?? 24 * 60 * 60 * 1000;
  const now = options.now ?? Date.now();
  const root = options.root ?? tempRoot();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return []; // nothing has ever run on this machine
  }

  const removed: string[] = [];
  for (const entry of entries) {
    const dir = join(root, entry);
    try {
      const info = await stat(dir);
      if (now - info.mtimeMs < maxAgeMs) continue;
    } catch {
      continue;
    }
    await removeJobDir(dir);
    removed.push(dir);
  }
  return removed;
}
