/**
 * The three AI stage names from SPEC-001 "GET /api/reports/:jobId → stage".
 *
 * Their own module so that `log.ts`, `client.ts` and `pipeline.ts` can share
 * them without importing each other.
 */

export const AI_STAGES = ["AI_PROJECT", "AI_COMMITS", "AI_WRITING"] as const;

export type AiStage = (typeof AI_STAGES)[number];
