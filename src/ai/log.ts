/**
 * Per-call AI logging (TASK-004 §5, SPEC-001 "Logging").
 *
 * What goes in: provider, model, token usage, latency, stage, attempt.
 * What must never go in: a prompt body, the user's `extraContext`, diff text.
 * The entry is therefore built from named numeric/short fields only — there is
 * no field on `AiCallLogEntry` that can carry prompt text — and the serialized
 * line still passes through TASK-003's redactor before it reaches the sink,
 * because a provider name is attacker-influenced text like any other.
 */

import { redactAll } from "../git/redact.ts";
import type { AiStage } from "./stages.ts";

export type LogSink = (line: string) => void;

export const consoleSink: LogSink = (line) => console.log(line);

export type AiCallLogEntry = {
  stage: AiStage;
  /** 1 = first try, 2 = the single retry (SPEC-001: 1 retry per call). */
  attempt: number;
  provider?: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  latencyMs?: number;
  /** Short failure reason, never a response body. */
  outcome: "ok" | "timeout" | "http-error" | "service-error" | "network-error";
};

/**
 * Correlation fields merged into the line before it is serialized (TASK-005
 * §7). SPEC-001 "Logging" wants `jobId` and `userId` on a structured line, and
 * this layer does not know either — the worker does, so it supplies them here
 * rather than emitting a second line that a reader would have to join.
 * Deliberately narrow: two ids, no free text, nothing that could carry a
 * prompt body.
 */
export type AiLogBaseFields = {
  jobId?: string;
  userId?: string;
};

export function logAiCall(
  entry: AiCallLogEntry,
  sink: LogSink,
  base: AiLogBaseFields = {},
): void {
  sink(redactAll(JSON.stringify({ component: "ai", ...base, ...entry }), []));
}
