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

export function logAiCall(entry: AiCallLogEntry, sink: LogSink): void {
  sink(redactAll(JSON.stringify({ component: "ai", ...entry }), []));
}
