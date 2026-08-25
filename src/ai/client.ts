/**
 * AI API CENTER client (TASK-004 §1, SPEC-001 "Flow 4–6").
 *
 * The request body now **always** carries an explicit `model` and `max_tokens`
 * (SPEC-007 §1 / TASK-027 §0, Q-BE-25): the pipeline threads a per-stage,
 * env-configurable model + budget into every call. `provider` stays **absent**
 * — the service's own fallback chain `deepseek → xai → gemini → openai` is
 * resilience we get for free, and a `model` outside a provider still lets the
 * service route it (contract: `{ provider?, model?, temperature?, max_tokens?,
 * messages }`, `AI-API-CENTER.md`). Before SPEC-007 neither `model` nor an
 * unconditional `max_tokens` was sent (SPEC-001 named no model per stage).
 *
 * Authentication: the stakeholder's stated fact today is "no auth now", so the
 * `Authorization` header is sent **only** when `AI_API_CENTER_TOKEN` is set —
 * turning auth on stays a config change, not a code change.
 */

import { AiLayerError } from "./errors.ts";
import {
  consoleSink,
  logAiCall,
  type AiLogBaseFields,
  type LogSink,
} from "./log.ts";
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
  /** Model id for this call (per-stage, env-configurable — SPEC-007 §1). */
  model: string;
  /** Completion cap for this call (per-stage, env-configurable — SPEC-007 §1). */
  max_tokens: number;
  messages: ChatMessage[];
  temperature?: number;
};

export interface AiClient {
  chat(request: ChatRequest): Promise<ChatResult>;
}

/**
 * The wire body. `stage` is ours and never leaves the process; `provider` is
 * absent by design (see the module comment). `model` and `max_tokens` are
 * always sent (SPEC-007 §1).
 */
export function chatBody(request: ChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: request.max_tokens,
    messages: request.messages,
  };
  if (request.temperature !== undefined) body.temperature = request.temperature;
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
  /** Correlation ids merged into every log line (TASK-005 §7). */
  logBase?: AiLogBaseFields;
  /**
   * Ordered model-level fallback chain (SPEC-007 §Fallback / D6, Req-7). Each is
   * tried, in order, after the primary model exhausts on a provider/model-side
   * failure. Empty/absent = today's behaviour (no fallback). Wired by
   * `routes.ts` from `Config.fallbackModels`; the client stays config-free.
   */
  fallbackModels?: string[];
  /**
   * Approved model → per-call `max_tokens` cap, used to clamp a fallback call to
   * the fallback model's cap (SPEC-007 D6b). Passed in by `routes.ts` so the ai
   * layer never imports `config.ts`. A model absent from the table is not
   * clamped.
   */
  modelCaps?: Record<string, number>;
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

/**
 * The ordered model chain for one call (SPEC-007 D6c): the request's primary
 * model first, then the configured fallbacks, de-duped preserving order — a
 * fallback equal to the primary (or repeated) is dropped, since retrying the
 * same model is pointless.
 */
export function buildModelChain(primary: string, fallbacks: string[]): string[] {
  const chain = [primary];
  for (const model of fallbacks) {
    if (!chain.includes(model)) chain.push(model);
  }
  return chain;
}

/**
 * Whether an exhausted model should advance to the next fallback (SPEC-007 D6a).
 * Fall back only on a provider/model-side exhaustion — the `retryable` failure
 * family (`timeout`/`network-error`/`http-error` 5xx/`service-error`
 * `success:false`), all of which today end in `AI_UNAVAILABLE`. A non-retryable
 * failure (a 4xx we built wrong, or a malformed *response*) fails identically on
 * any model, so it does **not** fall back — matching today's throw.
 */
export function shouldFallBack(failure: Failure): boolean {
  return failure.retryable === true;
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
  const logBase = options.logBase ?? {};

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

  const fallbackModels = options.fallbackModels ?? [];
  const modelCaps = options.modelCaps ?? {};

  /**
   * Run the existing per-model retry loop (`MAX_ATTEMPTS`) against one model.
   * Returns the success, or the last `Failure` (never throws) so the caller can
   * decide whether to advance to the next fallback model. `isFallback` only
   * affects the log line (SPEC-007 D6d marker).
   */
  async function runModel(
    request: ChatRequest,
    isFallback: boolean,
  ): Promise<ChatResult | Failure> {
    const fallback = isFallback ? true : undefined;
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
            fallback,
          },
          sink,
          logBase,
        );
        return outcome;
      }
      logAiCall(
        {
          stage: request.stage,
          attempt: tryNumber,
          outcome: outcome.outcome,
          // The model actually tried on this attempt (SPEC-007 D6d).
          model: request.model,
          fallback,
        },
        sink,
        logBase,
      );
      last = outcome;
      if (!outcome.retryable) break;
    }
    // MAX_ATTEMPTS >= 1, so `last` is always set once the loop ran.
    return last as Failure;
  }

  return {
    async chat(request: ChatRequest): Promise<ChatResult> {
      const chain = buildModelChain(request.model, fallbackModels);
      let last: Failure | undefined;
      for (let index = 0; index < chain.length; index += 1) {
        const model = chain[index] as string;
        const isFallback = index > 0;
        const cap = modelCaps[model];
        // SPEC-007 D6b: a fallback call honours the fallback model's per-call
        // cap; an uncapped/unknown model keeps the request's own budget.
        const maxTokens =
          cap !== undefined ? Math.min(request.max_tokens, cap) : request.max_tokens;
        const outcome = await runModel(
          { ...request, model, max_tokens: maxTokens },
          isFallback,
        );
        if (!isFailure(outcome)) return outcome;
        last = outcome;
        // Only a provider/model-side exhaustion advances to the next model.
        if (!shouldFallBack(outcome)) break;
      }
      throw new AiLayerError("AI_UNAVAILABLE", { detail: last?.detail });
    },
  };
}
