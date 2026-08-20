/**
 * The AI layer (TASK-004) — no database knowledge, no filesystem, no git.
 *
 * Everything the worker (TASK-005) needs to turn a read repository into a
 * finished report is behind this barrel.
 */

export * from "./stages.ts";
export * from "./errors.ts";
export * from "./log.ts";
export * from "./client.ts";
export * from "./prompts.ts";
export * from "./pipeline.ts";
export * from "./noCommitsReport.ts";
