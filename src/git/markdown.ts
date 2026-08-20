/**
 * Markdown digest (TASK-003 §5, SPEC-001 worker step 2).
 *
 * Order matters as much as the caps do: the root `README.md` first, then
 * `docs/**`, then everything else shallowest-first — so that when the caps bite,
 * what survives is the documentation that describes the project rather than a
 * changelog fragment six directories down.
 */

import { readFile } from "node:fs/promises";
import { listRepoFiles } from "./tree.ts";
import { runGit, type GitRunner } from "./run.ts";

export const MAX_MARKDOWN_FILES = 40;
export const MAX_CHARS_PER_FILE = 20_000;
export const MAX_TOTAL_CHARS = 200_000;
export const TRUNCATION_MARK = "…[truncated]";

export type MarkdownFile = {
  path: string;
  content: string;
  truncated: boolean;
};

export type MarkdownDigest = {
  files: MarkdownFile[];
  totalChars: number;
  /** Files that matched but did not fit under the caps. */
  omittedFiles: number;
};

function isMarkdown(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".mdx");
}

function depthOf(path: string): number {
  let depth = 0;
  for (const character of path) if (character === "/") depth += 1;
  return depth;
}

/** Root README first, then `docs/**`, then the rest by path depth. */
function rank(path: string): number {
  const lower = path.toLowerCase();
  if (lower === "readme.md" || lower === "readme.mdx") return 0;
  if (lower.startsWith("docs/")) return 1;
  return 2;
}

export function orderMarkdownPaths(paths: string[]): string[] {
  return [...paths].filter(isMarkdown).sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    const byDepth = depthOf(a) - depthOf(b);
    if (byDepth !== 0) return byDepth;
    return a.localeCompare(b);
  });
}

function truncate(content: string, limit: number): MarkdownFile["content"] {
  return content.slice(0, limit) + TRUNCATION_MARK;
}

export type ReadTextFile = (path: string) => Promise<string>;

/**
 * Read the repository's markdown under the three caps: 40 files, 20 000 chars
 * per file, 200 000 chars in total. Truncation is always visible in the text.
 */
export async function readMarkdownDigest(
  dir: string,
  options: { runner?: GitRunner; readTextFile?: ReadTextFile } = {},
): Promise<MarkdownDigest> {
  const paths = orderMarkdownPaths(
    await listRepoFiles(dir, options.runner ?? runGit),
  );
  const read =
    options.readTextFile ??
    ((path: string) => readFile(`${dir}/${path}`, "utf8"));

  const files: MarkdownFile[] = [];
  let totalChars = 0;
  let considered = 0;

  for (const path of paths) {
    considered += 1;
    if (files.length >= MAX_MARKDOWN_FILES) continue;
    if (totalChars >= MAX_TOTAL_CHARS) continue;

    let raw: string;
    try {
      raw = await read(path);
    } catch {
      continue; // a path git knows about but we cannot read is not fatal
    }

    let content = raw;
    let truncated = false;
    if (content.length > MAX_CHARS_PER_FILE) {
      content = truncate(content, MAX_CHARS_PER_FILE);
      truncated = true;
    }

    const remaining = MAX_TOTAL_CHARS - totalChars;
    if (content.length > remaining) {
      // Stay strictly inside the total budget, mark included.
      content = truncate(content, Math.max(0, remaining - TRUNCATION_MARK.length));
      truncated = true;
    }

    files.push({ path, content, truncated });
    totalChars += content.length;
  }

  return { files, totalChars, omittedFiles: considered - files.length };
}
