/**
 * The five **internal** AI stage names (SPEC-007 §Flow — the 5-stage redesign).
 *
 * These are the names the pipeline announces and the AI client logs. The
 * **wire** stage set is eight (`JOB_STAGES` in `reports/jobs.ts`); since
 * SPEC-008 the worker maps each internal stage onto the wire stage of the same
 * name (an identity map — the two reasoning stages are no longer folded onto
 * `AI_COMMITS`/`AI_WRITING`). Keeping them here (their own module) lets
 * `log.ts`, `client.ts` and `pipeline.ts` share them without importing each
 * other.
 */

export const AI_STAGES = [
  "AI_PROJECT",
  "AI_COMMITS",
  "AI_CURIOUSNESS",
  "AI_UNDERSTANDING",
  "AI_WRITING",
] as const;

export type AiStage = (typeof AI_STAGES)[number];
