/**
 * File tree (TASK-003 §4, SPEC-001 worker step 2).
 *
 * `git ls-files` rather than a directory walk: it already knows what is tracked
 * and what git ignores. Paths only — no file contents leave this function.
 *
 * The cap keeps the **shallowest** paths, because top-level structure is what
 * tells the AI what the project is; a deep leaf tells it almost nothing.
 */

import { runGit, type GitRunner } from "./run.ts";

export const MAX_TREE_PATHS = 2000;

/** Directory names excluded anywhere in the path (SPEC-001 worker step 2). */
const EXCLUDED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  "vendor",
]);

/** Lockfiles: enormous, generated, and say nothing about the dev work. */
const LOCKFILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "composer.lock",
  "gemfile.lock",
  "poetry.lock",
  "cargo.lock",
  "podfile.lock",
]);

/** Binary by extension — unreadable to a language model, large on the wire. */
const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "bmp", "webp", "ico", "icns", "tif", "tiff",
  "psd", "ai", "sketch", "fig",
  "mp3", "wav", "ogg", "flac", "mp4", "mov", "avi", "mkv", "webm",
  "zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "woff", "woff2", "ttf", "otf", "eot",
  "exe", "dll", "so", "dylib", "bin", "dat", "class", "jar", "wasm", "pyc",
  "db", "sqlite", "sqlite3", "lockb",
]);

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function isExcludedPath(path: string): boolean {
  const segments = path.split("/");
  const name = (segments[segments.length - 1] ?? "").toLowerCase();

  for (const segment of segments.slice(0, -1)) {
    if (EXCLUDED_DIRS.has(segment)) return true;
  }
  if (LOCKFILES.has(name)) return true;
  return BINARY_EXTENSIONS.has(extensionOf(path));
}

function depthOf(path: string): number {
  let depth = 0;
  for (const character of path) if (character === "/") depth += 1;
  return depth;
}

/** Keep the shallowest `limit` paths, then restore alphabetical order. */
export function capPaths(paths: string[], limit: number = MAX_TREE_PATHS): string[] {
  if (paths.length <= limit) return paths;
  const byDepth = [...paths].sort((a, b) => {
    const difference = depthOf(a) - depthOf(b);
    return difference !== 0 ? difference : a.localeCompare(b);
  });
  return byDepth.slice(0, limit).sort((a, b) => a.localeCompare(b));
}

/**
 * Every tracked, non-excluded path — **uncapped**. `readFileTree` caps this for
 * the AI prompt; the markdown digest picks its files from the full list so a
 * README can never be lost to the tree cap.
 */
export async function listRepoFiles(
  dir: string,
  runner: GitRunner = runGit,
): Promise<string[]> {
  const result = await runner(["-C", dir, "ls-files", "-z"]);
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split("\0")
    .filter((path) => path !== "")
    .filter((path) => !isExcludedPath(path))
    .sort((a, b) => a.localeCompare(b));
}

export type FileTree = {
  paths: string[];
  /** Paths dropped by the cap — worth a log line, and honest in the prompt. */
  omitted: number;
};

export async function readFileTree(
  dir: string,
  options: { runner?: GitRunner; limit?: number } = {},
): Promise<FileTree> {
  const all = await listRepoFiles(dir, options.runner ?? runGit);
  const limit = options.limit ?? MAX_TREE_PATHS;
  const paths = capPaths(all, limit);
  return { paths, omitted: all.length - paths.length };
}
