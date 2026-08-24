/**
 * The five **internal** AI stage names (SPEC-007 §Flow — the 5-stage redesign).
 *
 * These are the names the pipeline announces and the AI client logs. The
 * **wire** stage set stays six (`JOB_STAGES` in `reports/jobs.ts`); the worker
 * maps the two new internal stages onto existing wire stages before reporting
 * (`AI_CURIOUSNESS` → `AI_COMMITS`, `AI_UNDERSTANDING` → `AI_WRITING`; SPEC-007
 * D-wire). Keeping them here (their own module) lets `log.ts`, `client.ts` and
 * `pipeline.ts` share them without importing each other.
 */

export const AI_STAGES = [
  "AI_PROJECT",
  "AI_COMMITS",
  "AI_CURIOUSNESS",
  "AI_UNDERSTANDING",
  "AI_WRITING",
] as const;

export type AiStage = (typeof AI_STAGES)[number];
