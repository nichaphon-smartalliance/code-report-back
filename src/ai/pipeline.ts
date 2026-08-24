/**
 * The five-stage analysis (SPEC-007 §Flow, replacing TASK-004's three stages):
 * `AI_PROJECT → AI_COMMITS → AI_CURIOUSNESS → AI_UNDERSTANDING → AI_WRITING`.
 *
 * Every AI call threads its own **stage** `model` + `max_tokens` (SPEC-007 §1).
 * Stage 2 stays **sequential on purpose**: each call is large, the stakeholder's
 * service fans out to third-party providers, and nothing here needs the latency.
 *
 * This module never touches the network directly, never touches the database,
 * and never reads the filesystem: the `AiClient`, the `RepoInspector` (real
 * repo access, built by the worker over the live clone) and the
 * `CuriosityInvestigator` all arrive as arguments, so the whole pipeline is
 * testable against fakes.
 */

import type { AiStagesConfig } from "../config.ts";
import type { Commit } from "../git/commits.ts";
import type { RepoInspector } from "../git/inspect.ts";
import type { MarkdownDigest } from "../git/markdown.ts";
import type { FileTree } from "../git/tree.ts";
import type { AiClient } from "./client.ts";
import {
  batchCommits,
  formatReportParams,
  parseTopicPlan,
  stage1Messages,
  stage2Messages,
  understandingMessages,
  writingPlanMessages,
  writingSectionMessages,
  type ReportParams,
} from "./prompts.ts";
import type { AiStage } from "./stages.ts";

/**
 * Where stage 2 has got to, for a caller that wants to show it.
 *
 * Deliberately **not** `{current, total}`: SPEC-001 "GET /api/reports/:jobId"
 * uses those two names for the wire field `progress`, whose `total` is the
 * number of `stage` values (six) — a different quantity entirely. This module
 * does not own that field and must not hand out something that can be
 * forwarded onto the wire by mistake. `batch` is present only during
 * `AI_COMMITS`.
 */
export type StagePosition = {
  batch?: number;
  batchCount: number;
};

export type StageCallback = (
  stage: AiStage,
  position: StagePosition,
) => void | Promise<void>;

/**
 * The AI_CURIOUSNESS seam. This task ships only a **pass-through**
 * implementation (`passThroughInvestigator`); TASK-028 supplies the real
 * text-action loop over `RepoInspector` and swaps it in at the worker's
 * construction site.
 */
export type CuriosityInput = {
  profile: string;
  batchSummaries: string[];
  inspector: RepoInspector;
  client: AiClient;
  /** Per-call model + budget for AI_CURIOUSNESS (SPEC-007 §1). */
  model: string;
  maxTokens: number;
  /** Loop cap (`AI_CURIOUSNESS_MAX_ITERATIONS`, SPEC-007 §Flow 3). */
  maxIterations: number;
  extraContext?: string | undefined;
};

export interface CuriosityInvestigator {
  /** Accumulated investigation `findings`, or `""` when nothing was gathered. */
  investigate(input: CuriosityInput): Promise<string>;
}

/**
 * The trivial investigator: gathers nothing, makes no AI call. It keeps the
 * pipeline complete and unit-testable now; TASK-028 replaces it with the real
 * loop body.
 */
export const passThroughInvestigator: CuriosityInvestigator = {
  async investigate(): Promise<string> {
    return "";
  },
};

export type PipelineInput = {
  client: AiClient;
  tree: FileTree;
  markdown: MarkdownDigest;
  /** Non-empty: zero commits is `NO_COMMITS` and never reaches this module. */
  commits: Commit[];
  params: ReportParams;
  extraContext?: string | undefined;
  /** Per-stage model + max_tokens for every AI call (SPEC-007 §1, TASK-025). */
  aiStages: AiStagesConfig;
  /** Real repo access for AI_CURIOUSNESS (built by the worker over the clone). */
  inspector: RepoInspector;
  /** AI_CURIOUSNESS loop body (pass-through here; real in TASK-028). */
  investigator: CuriosityInvestigator;
  /** `AI_CURIOUSNESS_MAX_ITERATIONS` (SPEC-007 §Flow 3). */
  curiosityMaxIterations: number;
  /** `AI_WRITING_MAX_PASSES` (SPEC-007 §Flow 5). */
  writingMaxPasses: number;
  onStage?: StageCallback;
};

export type PipelineResult = {
  /** The final report, Markdown, in `params.language`. */
  markdown: string;
  profile: string;
  batchSummaries: string[];
  /** AI_CURIOUSNESS output — "" for the pass-through investigator. */
  findings: string;
  /** AI_UNDERSTANDING output. */
  understanding: string;
  /** The ordered AI_WRITING topic plan actually written. */
  topics: string[];
  /** Total number of AI calls this module made directly (excludes the
   *  investigator's own internal calls). */
  calls: number;
};

export async function runPipeline(
  input: PipelineInput,
): Promise<PipelineResult> {
  const { client, params, extraContext, aiStages, inspector, investigator } =
    input;
  const batches = batchCommits(input.commits);
  const batchCount = batches.length;
  let calls = 0;

  const announce = async (stage: AiStage, batch?: number): Promise<void> => {
    await input.onStage?.(
      stage,
      batch === undefined ? { batchCount } : { batch, batchCount },
    );
  };

  // Stage 1 — AI_PROJECT.
  await announce("AI_PROJECT");
  const profile = (
    await client.chat({
      stage: "AI_PROJECT",
      model: aiStages.AI_PROJECT.model,
      max_tokens: aiStages.AI_PROJECT.maxTokens,
      messages: stage1Messages({
        tree: input.tree,
        markdown: input.markdown,
        extraContext,
      }),
    })
  ).content;
  calls += 1;

  // Stage 2 — AI_COMMITS (sequential, 20/batch).
  const batchSummaries: string[] = [];
  for (const [index, batch] of batches.entries()) {
    await announce("AI_COMMITS", index + 1);
    const summary = await client.chat({
      stage: "AI_COMMITS",
      model: aiStages.AI_COMMITS.model,
      max_tokens: aiStages.AI_COMMITS.maxTokens,
      messages: stage2Messages({
        profile,
        commits: batch,
        batchNumber: index + 1,
        batchCount: batches.length,
        extraContext,
      }),
    });
    batchSummaries.push(summary.content);
    calls += 1;
  }

  // Stage 3 — AI_CURIOUSNESS (delegated; pass-through makes no AI call).
  await announce("AI_CURIOUSNESS");
  const findings = await investigator.investigate({
    profile,
    batchSummaries,
    inspector,
    client,
    model: aiStages.AI_CURIOUSNESS.model,
    maxTokens: aiStages.AI_CURIOUSNESS.maxTokens,
    maxIterations: input.curiosityMaxIterations,
    ...(extraContext === undefined ? {} : { extraContext }),
  });

  // Stage 4 — AI_UNDERSTANDING.
  await announce("AI_UNDERSTANDING");
  const understanding = (
    await client.chat({
      stage: "AI_UNDERSTANDING",
      model: aiStages.AI_UNDERSTANDING.model,
      max_tokens: aiStages.AI_UNDERSTANDING.maxTokens,
      messages: understandingMessages({
        profile,
        batchSummaries,
        findings,
        extraContext,
      }),
    })
  ).content;
  calls += 1;

  // Stage 5 — AI_WRITING: plan ≤ maxPasses topics, then one section per topic.
  await announce("AI_WRITING");
  const plan = await client.chat({
    stage: "AI_WRITING",
    model: aiStages.AI_WRITING.model,
    max_tokens: aiStages.AI_WRITING.maxTokens,
    messages: writingPlanMessages({
      understanding,
      batchSummaries,
      maxPasses: input.writingMaxPasses,
      extraContext,
    }),
  });
  calls += 1;
  const topics = parseTopicPlan(plan.content, input.writingMaxPasses);

  const sections: string[] = [];
  for (let topicIndex = 0; topicIndex < topics.length; topicIndex += 1) {
    const section = await client.chat({
      stage: "AI_WRITING",
      model: aiStages.AI_WRITING.model,
      max_tokens: aiStages.AI_WRITING.maxTokens,
      messages: writingSectionMessages({
        understanding,
        batchSummaries,
        params,
        topics,
        topicIndex,
        extraContext,
      }),
    });
    sections.push(section.content);
    calls += 1;
  }

  // Assembly (D2): deterministic, ordered concatenation behind a fixed header.
  // No extra AI "stitch" call.
  const markdown = assembleReport(params, sections);

  return {
    markdown,
    profile,
    batchSummaries,
    findings,
    understanding,
    topics,
    calls,
  };
}

/**
 * The report is a fixed header (SPEC-001 `formatReportParams`) followed by the
 * topic sections in order — pure string work, no AI (SPEC-007 D2).
 */
function assembleReport(params: ReportParams, sections: string[]): string {
  return [formatReportParams(params), ...sections].join("\n\n");
}
