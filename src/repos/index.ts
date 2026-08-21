/**
 * The repository-inspection layer (TASK-017) — two read-only endpoints the
 * new-report form calls before a job exists.
 *
 * Nothing here persists anything: no table, no job row, no cache. The PAT
 * travels from the request body to the git layer as an argument and exists
 * nowhere else (SPEC-001 "PAT handling").
 */

export * from "./validate.ts";
export * from "./routes.ts";
