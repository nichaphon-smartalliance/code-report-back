/**
 * The chained three-stage analysis (TASK-004 §3, SPEC-001 "Flow 4–6").
 *
 * Stage 2 is **sequential on purpose**: each call is large, the stakeholder's
 * service fans out to third-party providers, and nothing here needs the
 * latency. It also keeps the `stage` callback honest — the worker (TASK-005)
 * persists the stage it reports, and a stage that jumps around is worse than
 * one that is slow.
 *
 * This module never touches the network directly, never touches the database,
 * and never reads the filesystem: everything arrives as arguments, so the
 * whole pipeline is testable against a fake `AiClient`.
 */

import type { Commit } from "../git/commits.ts";
import type { MarkdownDigest } from "../git/markdown.ts";
import type { FileTree } from "../git/tree.ts";
import type { AiClient } from "./client.ts";
import {
  batchCommits,
  stage1Messages,
  stage2Messages,
  stage3Messages,
  type ReportParams,
} from "./prompts.ts";
import type { AiStage } from "./stages.ts";

/**
 * Where stage 2 has got to, for a caller that wants to show it.
 *
 * Deliberately **not** `{current, total}`: SPEC-001 "GET /api/reports/:jobId"
 * uses those two names for the wire field `progress`, whose `total` is the
 * number of `status` values (six) — a different quantity entirely. This module
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

export type PipelineInput = {
  client: AiClient;
  tree: FileTree;
  markdown: MarkdownDigest;
  /** Non-empty: zero commits is `NO_COMMITS` and never reaches this module. */
  commits: Commit[];
  params: ReportParams;
  extraContext?: string | undefined;
  onStage?: StageCallback;
};

export type PipelineResult = {
  /** The final report, Markdown, in `params.language`. */
  markdown: string;
  profile: string;
  batchSummaries: string[];
  /** Total number of AI calls made — 1 + batches + 1. */
  calls: number;
};

export async function runPipeline(
  input: PipelineInput,
): Promise<PipelineResult> {
  const { client, params, extraContext } = input;
  const batches = batchCommits(input.commits);
  const batchCount = batches.length;

  const announce = async (stage: AiStage, batch?: number): Promise<void> => {
    await input.onStage?.(
      stage,
      batch === undefined ? { batchCount } : { batch, batchCount },
    );
  };

  await announce("AI_PROJECT");
  const profile = (
    await client.chat({
      stage: "AI_PROJECT",
      messages: stage1Messages({
        tree: input.tree,
        markdown: input.markdown,
        extraContext,
      }),
    })
  ).content;

  const batchSummaries: string[] = [];
  for (const [index, batch] of batches.entries()) {
    await announce("AI_COMMITS", index + 1);
    const summary = await client.chat({
      stage: "AI_COMMITS",
      messages: stage2Messages({
        profile,
        commits: batch,
        batchNumber: index + 1,
        batchCount: batches.length,
        extraContext,
      }),
    });
    batchSummaries.push(summary.content);
  }

  await announce("AI_WRITING");
  const report = await client.chat({
    stage: "AI_WRITING",
    messages: stage3Messages({
      profile,
      batchSummaries,
      params,
      commits: input.commits,
      extraContext,
    }),
  });

  return {
    markdown: report.content,
    profile,
    batchSummaries,
    calls: batchCount + 2,
  };
}
