/**
 * The git layer (TASK-003) — no HTTP, no database knowledge.
 *
 * Everything the worker (TASK-005) needs from a repository is behind this
 * barrel: clone, read the tree, read the markdown, read the commits, clean up.
 */

export * from "./errors.ts";
export * from "./redact.ts";
export * from "./urlSafety.ts";
export * from "./run.ts";
export * from "./clone.ts";
export * from "./lsRemote.ts";
export * from "./tree.ts";
export * from "./markdown.ts";
export * from "./commits.ts";
export * from "./cleanup.ts";
