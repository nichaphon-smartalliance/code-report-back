/**
 * AI API CENTER client (TASK-004 §1, SPEC-001 "Flow 4–6").
 *
 * Two deliberate absences in every request body:
 *   - **no `provider`** — the service's own fallback chain
 *     `deepseek → xai → gemini → openai` is resilience we get for free;
 *   - **no `model`** — SPEC-001 never names one, and a model id is
 *     provider-specific, so pinning one here would defeat the fallback above.
 *     See TASK-004 `## Questions` (Q-BE-6) for the tier→model mapping that is
 *     Sober's call; until it is made, the service picks.
 *
 * Authentication: the stakeholder's stated fact today is "no auth now", so the
 * `Authorization` header is sent **only** when `AI_API_CENTER_TOKEN` is set —
 * turning auth on stays a config change, not a code change.
 */

import { AiLayerError } from "./errors.ts";
import { consoleSink, logAiCall, type LogSink } from "./log.ts";
import type { AiStage } from "./stages.ts";

/** SPEC-001 "Flow 4–6": 120 s per call. */
export const AI_TIMEOUT_MS = 120_000;
/** One try, then exactly one retry (SPEC-001). */
export const MAX_ATTEMPTS = 2;

export type ChatMessage = { role: "system" | "user"; content: string };

export type Usage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

export type ChatResult = {
  provider: string;
  model: string;
  content: string;
  usage: Usage;
  latency_ms: number;
};

export type ChatRequest = {
  /** Which pipeline stage this call belongs to — used for logging only. */
  stage: AiStage;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
};

export interface AiClient {
  chat(request: ChatRequest): Promise<ChatResult>;
}

/**
 * The wire body. `stage` is ours and never leaves the process; `provider` and
 * `model` are absent by design (see the module comment).
 */
export function chatBody(request: ChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = { messages: request.messages };
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.max_tokens !== undefined) body.max_tokens = request.max_tokens;
  return body;
}

export function chatHeaders(token: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== undefined && token.trim() !== "") {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

export function chatUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat`;
}

export type HttpAiClientOptions = {
  baseUrl: string;
  /** `Config.AI_API_CENTER_TOKEN` — undefined today. Never logged. */
  token?: string | undefined;
  fetchImpl?: typeof fetch;
  sink?: LogSink;
  /** Overridable so tests do not wait two minutes. */
  timeoutMs?: number;
};

/** A failed attempt, classified for the retry decision and the log line. */
type Failure = {
  outcome: "timeout" | "http-error" | "service-error" | "network-error";
  retryable: boolean;
  detail: string;
};

function isFailure(value: unknown): value is Failure {
  return typeof value === "object" && value !== null && "outcome" in value;
}

function parseResult(payload: unknown): ChatResult | Failure {
  if (typeof payload !== "object" || payload === null) {
    return {
      outcome: "service-error",
      retryable: false,
      detail: "response was not a JSON object",
    };
  }
  const envelope = payload as { success?: unknown; data?: unknown };
  if (envelope.success !== true) {
    // `{success:false}` is a retryable failure (TASK-004 DoD).
    return {
      outcome: "service-error",
      retryable: true,
      detail: "service reported success:false",
    };
  }
  const data = envelope.data as Partial<ChatResult> | undefined;
  if (data === undefined || typeof data.content !== "string") {
    return {
      outcome: "service-error",
      retryable: false,
      detail: "success:true but data.content was missing",
    };
  }
  return {
    provider: typeof data.provider === "string" ? data.provider : "unknown",
    model: typeof data.model === "string" ? data.model : "unknown",
    content: data.content,
    usage: {
      prompt_tokens: data.usage?.prompt_tokens ?? 0,
      completion_tokens: data.usage?.completion_tokens ?? 0,
      total_tokens: data.usage?.total_tokens ?? 0,
    },
    latency_ms: typeof data.latency_ms === "number" ? data.latency_ms : 0,
  };
}

export function createHttpAiClient(options: HttpAiClientOptions): AiClient {
  const doFetch = options.fetchImpl ?? fetch;
  const sink = options.sink ?? consoleSink;
  const timeoutMs = options.timeoutMs ?? AI_TIMEOUT_MS;
  const url = chatUrl(options.baseUrl);
  const headers = chatHeaders(options.token);

  async function attempt(request: ChatRequest): Promise<ChatResult | Failure> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(chatBody(request)),
        signal: controller.signal,
      });
      if (response.status >= 500) {
        return {
          outcome: "http-error",
          retryable: true,
          detail: `HTTP ${response.status}`,
        };
      }
      if (!response.ok) {
        // 4xx is a request we sent wrong; retrying sends it wrong again.
        return {
          outcome: "http-error",
          retryable: false,
          detail: `HTTP ${response.status}`,
        };
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return {
          outcome: "service-error",
          retryable: false,
          detail: "response body was not JSON",
        };
      }
      return parseResult(payload);
    } catch (error) {
      if (controller.signal.aborted) {
        return {
          outcome: "timeout",
          retryable: true,
          detail: `no response within ${timeoutMs} ms`,
        };
      }
      // Connection refused / DNS / socket reset: the same transient family as a
      // timeout, so it gets the same single retry.
      return {
        outcome: "network-error",
        retryable: true,
        detail: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async chat(request: ChatRequest): Promise<ChatResult> {
      let last: Failure | undefined;
      for (let tryNumber = 1; tryNumber <= MAX_ATTEMPTS; tryNumber += 1) {
        const outcome = await attempt(request);
        if (!isFailure(outcome)) {
          logAiCall(
            {
              stage: request.stage,
              attempt: tryNumber,
              outcome: "ok",
              provider: outcome.provider,
              model: outcome.model,
              promptTokens: outcome.usage.prompt_tokens,
              completionTokens: outcome.usage.completion_tokens,
              totalTokens: outcome.usage.total_tokens,
              latencyMs: outcome.latency_ms,
            },
            sink,
          );
          return outcome;
        }
        logAiCall(
          { stage: request.stage, attempt: tryNumber, outcome: outcome.outcome },
          sink,
        );
        last = outcome;
        if (!outcome.retryable) break;
      }
      throw new AiLayerError("AI_UNAVAILABLE", { detail: last?.detail });
    },
  };
}
