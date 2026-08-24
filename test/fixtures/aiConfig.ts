/**
 * Test defaults for the per-stage AI config and the injected `RepoInspector`
 * (SPEC-007 / TASK-025 / TASK-026). These mirror the shipped config defaults so
 * the pipeline and worker can be exercised without loading real env config.
 */

import type { AiStagesConfig } from "../../src/config.ts";
import type { RepoInspector, SearchHit } from "../../src/git/inspect.ts";

/** The shipped model→stage defaults (SPEC-007 D3), as a ready-made config. */
export const TEST_AI_STAGES: AiStagesConfig = {
  AI_PROJECT: { model: "gpt-4.1-mini", maxTokens: 20000 },
  AI_COMMITS: { model: "gpt-4.1-mini", maxTokens: 20000 },
  AI_CURIOUSNESS: { model: "grok-4-latest", maxTokens: 50000 },
  AI_UNDERSTANDING: { model: "gpt-4.1", maxTokens: 40000 },
  AI_WRITING: { model: "gpt-4.1", maxTokens: 50000 },
};

export const TEST_CURIOSITY_MAX_ITERATIONS = 5;
export const TEST_WRITING_MAX_PASSES = 3;

/** An inert inspector: the pass-through investigator never calls it. */
export function fakeRepoInspector(): RepoInspector {
  return {
    async listTree(): Promise<string[]> {
      return [];
    },
    async readFile(): Promise<string> {
      return "";
    },
    async search(): Promise<SearchHit[]> {
      return [];
    },
  };
}
