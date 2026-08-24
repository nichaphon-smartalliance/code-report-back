/**
 * RepoInspector (TASK-026, SPEC-007 §Flow step 3 + §"Data-safety bounds for
 * RepoInspector" (D5)).
 *
 * A path-confined, size-capped, injectable read-only view over an already-cloned
 * repository on disk. AI_CURIOUSNESS (SPEC-007 stage 3) drives it through the
 * text-action protocol to gather missing information about the real code:
 * list the tree, open a file by path, search a word across the project.
 *
 * Three guarantees, all from D5:
 *   - **Local files only.** Never contacts the remote, never sees the PAT, never
 *     touches the database. The clone lifecycle is the worker's (`withClone`);
 *     this module only reads what is already on disk.
 *   - **Path confinement.** Every `readFile` path is resolved against the clone
 *     root and rejected — lexically *and* after symlink resolution — if it
 *     escapes. The model can only reach files inside this job's clone.
 *   - **Size / hit caps.** Reuses the existing constants (`MAX_TREE_PATHS`,
 *     `MAX_CHARS_PER_FILE` + `TRUNCATION_MARK`); `search` bounds the hit count.
 *
 * A missing/binary/unreadable file or an escaping path returns a short typed
 * sentinel string, never a throw — one bad request must not abort the loop.
 */

import { readFile as fsReadFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { runGit, type GitRunner } from "./run.ts";
import { readFileTree } from "./tree.ts";
import { MAX_CHARS_PER_FILE, TRUNCATION_MARK } from "./markdown.ts";

/** A capped literal-match hit from `search`. */
export type SearchHit = {
  path: string;
  line: number;
  text: string;
};

export interface RepoInspector {
  /** Capped file list (reuses `readFileTree` → `MAX_TREE_PATHS`). */
  listTree(): Promise<string[]>;
  /** Capped, truncation-marked file contents, or a typed sentinel. */
  readFile(path: string): Promise<string>;
  /** Capped literal-match hits for `word` (`git grep --fixed-strings`). */
  search(word: string): Promise<SearchHit[]>;
}

/** Upper bound on hits returned by `search`, so one word can't flood the loop. */
export const MAX_SEARCH_HITS = 200;

/** Returned by `readFile` when the path escapes the clone root. */
export const OUTSIDE_REPO_MARK = "…[path outside repository — refused]";
/** Returned by `readFile` when the path is not a readable file. */
export const NOT_FOUND_MARK = "…[file not found or unreadable]";
/** Returned by `readFile` when the file is binary. */
export const BINARY_FILE_MARK = "…[binary file — not shown]";

export type ReadBytes = (absolutePath: string) => Promise<Uint8Array>;

export type RepoInspectorOptions = {
  /** Test seam for the git process (same pattern as the other git modules). */
  runner?: GitRunner;
  /** Test seam for reading a file's raw bytes. */
  readBytes?: ReadBytes;
  /** Override the hit cap (defaults to `MAX_SEARCH_HITS`). */
  maxSearchHits?: number;
};

function truncate(content: string): string {
  return content.slice(0, MAX_CHARS_PER_FILE) + TRUNCATION_MARK;
}

/** A NUL byte is git's own binary heuristic — good enough here, and cheap. */
function looksBinary(bytes: Uint8Array): boolean {
  const scan = Math.min(bytes.length, 8000);
  for (let index = 0; index < scan; index += 1) {
    if (bytes[index] === 0) return true;
  }
  return false;
}

/**
 * True when `child` is strictly inside `root` (both already absolute).
 * `relative` yields a `..`-leading or absolute path exactly when it escapes.
 */
function isInside(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function parseGrep(stdout: string, limit: number): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const raw of stdout.split("\n")) {
    if (hits.length >= limit) break;
    if (raw === "") continue;
    // `git grep -n` prints `path:line:text`; a path or the text may itself
    // contain colons, so split only the first two fields.
    const firstColon = raw.indexOf(":");
    if (firstColon <= 0) continue;
    const secondColon = raw.indexOf(":", firstColon + 1);
    if (secondColon <= firstColon) continue;
    const path = raw.slice(0, firstColon);
    const line = Number(raw.slice(firstColon + 1, secondColon));
    if (!Number.isInteger(line)) continue;
    hits.push({ path, line, text: raw.slice(secondColon + 1) });
  }
  return hits;
}

export function createRepoInspector(
  dir: string,
  options: RepoInspectorOptions = {},
): RepoInspector {
  const runner = options.runner ?? runGit;
  const readBytes = options.readBytes ?? ((path: string) => fsReadFile(path));
  const hitLimit = options.maxSearchHits ?? MAX_SEARCH_HITS;
  const root = resolve(dir);

  async function listTree(): Promise<string[]> {
    const tree = await readFileTree(dir, { runner });
    return tree.paths;
  }

  async function readFile(path: string): Promise<string> {
    // 1. Lexical confinement: reject an absolute path or one that escapes root.
    if (isAbsolute(path)) return OUTSIDE_REPO_MARK;
    const target = resolve(root, path);
    if (!isInside(root, target)) return OUTSIDE_REPO_MARK;

    // 2. Symlink confinement: resolve real paths and re-check. A missing file
    //    (realpath throws ENOENT) is "not found", not an escape.
    let realTarget: string;
    let realRoot: string;
    try {
      realRoot = await realpath(root);
    } catch {
      return NOT_FOUND_MARK;
    }
    try {
      realTarget = await realpath(target);
    } catch {
      return NOT_FOUND_MARK;
    }
    if (!isInside(realRoot, realTarget)) return OUTSIDE_REPO_MARK;

    // 3. Read, detect binary, cap.
    let bytes: Uint8Array;
    try {
      bytes = await readBytes(realTarget);
    } catch {
      return NOT_FOUND_MARK;
    }
    if (looksBinary(bytes)) return BINARY_FILE_MARK;
    const content = Buffer.from(bytes).toString("utf8");
    return content.length > MAX_CHARS_PER_FILE ? truncate(content) : content;
  }

  async function search(word: string): Promise<SearchHit[]> {
    // `-e <word>` keeps a leading-dash word a literal pattern, not a flag;
    // `--fixed-strings` makes it a literal, never a regex; `-I` skips binaries;
    // `--` ends options. The word is passed as its own argv element (never a
    // shell string) by `runGit`.
    if (word === "") return [];
    const result = await runner([
      "-C",
      dir,
      "grep",
      "--no-color",
      "-n",
      "-I",
      "--fixed-strings",
      "-e",
      word,
      "--",
    ]);
    // git grep: 0 = matches, 1 = no matches (not an error), >1 = real failure.
    if (result.exitCode !== 0) return [];
    return parseGrep(result.stdout, hitLimit);
  }

  return { listTree, readFile, search };
}
