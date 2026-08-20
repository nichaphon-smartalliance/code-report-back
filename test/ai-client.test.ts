/**
 * TASK-004 §1 — the AI API CENTER client, against a fake `fetch`.
 * **No test in this file touches the network or the live service.**
 */

import { describe, expect, test } from "bun:test";
import {
  chatBody,
  chatHeaders,
  chatUrl,
  createHttpAiClient,
  MAX_ATTEMPTS,
  type ChatRequest,
} from "../src/ai/client.ts";
import { AiLayerError } from "../src/ai/errors.ts";

const REQUEST: ChatRequest = {
  stage: "AI_PROJECT",
  messages: [{ role: "user", content: "hello" }],
};

function okBody(content = "answer") {
  return {
    success: true,
    data: {
      provider: "deepseek",
      model: "deepseek-chat",
      content,
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      latency_ms: 42,
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A fetch that plays the given responses in order; each entry is a factory
 * receiving the request's `AbortSignal`, exactly as the real `fetch` gets it.
 */
type Step = (signal: AbortSignal | null | undefined) => Promise<Response>;

function scriptedFetch(steps: Step[]): {
  fetchImpl: typeof fetch;
  calls: { url: string; init: RequestInit | undefined }[];
} {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  let index = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const step = steps[Math.min(index, steps.length - 1)];
    index += 1;
    if (step === undefined) throw new Error("no scripted response");
    return step(init?.signal);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/**
 * Never answers; rejects when the client's own AbortController fires — which
 * is precisely what the platform `fetch` does on abort.
 */
const hanging: Step = (signal) =>
  new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new Error("aborted")));
  });

describe("request shape", () => {
  test("the body carries messages and NEVER a provider or model key", () => {
    const body = chatBody({
      stage: "AI_COMMITS",
      messages: [{ role: "user", content: "x" }],
      temperature: 0.2,
    });
    expect(Object.keys(body).sort()).toEqual(["messages", "temperature"]);
    expect("provider" in body).toBe(false);
    expect("model" in body).toBe(false);
    // `stage` is ours for logging — it must not reach the wire either.
    expect("stage" in body).toBe(false);
  });

  test("no Authorization header when AI_API_CENTER_TOKEN is unset", () => {
    expect(chatHeaders(undefined)["Authorization"]).toBeUndefined();
    expect(chatHeaders("")["Authorization"]).toBeUndefined();
    expect(chatHeaders("  ")["Authorization"]).toBeUndefined();
  });

  test("Authorization: Bearer when the token is set", () => {
    expect(chatHeaders("t0ken")["Authorization"]).toBe("Bearer t0ken");
  });

  test("the URL is <base>/chat, with a trailing slash tolerated", () => {
    expect(chatUrl("http://localhost:3009")).toBe("http://localhost:3009/chat");
    expect(chatUrl("https://ai.develyst.online/")).toBe(
      "https://ai.develyst.online/chat",
    );
  });

  test("the sent request matches those rules end to end", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      async () => jsonResponse(okBody()),
    ]);
    const client = createHttpAiClient({
      baseUrl: "http://localhost:3009",
      fetchImpl,
      sink: () => {},
    });
    await client.chat(REQUEST);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://localhost:3009/chat");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
    const sent = JSON.parse(String(calls[0]?.init?.body));
    expect(sent.provider).toBeUndefined();
    expect(sent.model).toBeUndefined();
    expect(sent.messages).toEqual(REQUEST.messages);
  });
});

describe("responses and retry (1 retry, then AI_UNAVAILABLE)", () => {
  test("a success returns provider/model/usage/latency", async () => {
    const { fetchImpl } = scriptedFetch([async () => jsonResponse(okBody("hi"))]);
    const client = createHttpAiClient({
      baseUrl: "http://x",
      fetchImpl,
      sink: () => {},
    });
    const result = await client.chat(REQUEST);
    expect(result.content).toBe("hi");
    expect(result.provider).toBe("deepseek");
    expect(result.model).toBe("deepseek-chat");
    expect(result.usage.total_tokens).toBe(3);
    expect(result.latency_ms).toBe(42);
  });

  test("one timeout → retried once → success", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      hanging,
      async () => jsonResponse(okBody("second try")),
    ]);
    const client = createHttpAiClient({
      baseUrl: "http://x",
      fetchImpl,
      sink: () => {},
      timeoutMs: 20,
    });
    expect((await client.chat(REQUEST)).content).toBe("second try");
    expect(calls).toHaveLength(2);
  });

  test("two timeouts → AI_UNAVAILABLE after exactly 2 attempts", async () => {
    const { fetchImpl, calls } = scriptedFetch([hanging, hanging]);
    const client = createHttpAiClient({
      baseUrl: "http://x",
      fetchImpl,
      sink: () => {},
      timeoutMs: 20,
    });
    const error = (await client.chat(REQUEST).catch((e: unknown) => e)) as AiLayerError;
    expect(error).toBeInstanceOf(AiLayerError);
    expect(error.code).toBe("AI_UNAVAILABLE");
    expect(calls).toHaveLength(MAX_ATTEMPTS);
  });

  test("HTTP 500 is retried, then AI_UNAVAILABLE", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      async () => jsonResponse({ success: false, error: "boom" }, 500),
    ]);
    const client = createHttpAiClient({
      baseUrl: "http://x",
      fetchImpl,
      sink: () => {},
    });
    await expect(client.chat(REQUEST)).rejects.toThrow(AiLayerError);
    expect(calls).toHaveLength(2);
  });

  test("{success:false} with HTTP 200 is a failure, retried once", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      async () => jsonResponse({ success: false, error: "provider down" }),
      async () => jsonResponse(okBody("recovered")),
    ]);
    const client = createHttpAiClient({
      baseUrl: "http://x",
      fetchImpl,
      sink: () => {},
    });
    expect((await client.chat(REQUEST)).content).toBe("recovered");
    expect(calls).toHaveLength(2);
  });

  test("a 4xx is not retried — the same bad request would fail again", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      async () => jsonResponse({ success: false, error: "bad request" }, 400),
    ]);
    const client = createHttpAiClient({
      baseUrl: "http://x",
      fetchImpl,
      sink: () => {},
    });
    await expect(client.chat(REQUEST)).rejects.toThrow(AiLayerError);
    expect(calls).toHaveLength(1);
  });

  test("a network error is retried like a timeout", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      async () => {
        throw new Error("ECONNREFUSED");
      },
      async () => jsonResponse(okBody("up again")),
    ]);
    const client = createHttpAiClient({
      baseUrl: "http://x",
      fetchImpl,
      sink: () => {},
    });
    expect((await client.chat(REQUEST)).content).toBe("up again");
    expect(calls).toHaveLength(2);
  });
});

describe("logging (TASK-004 §5)", () => {
  const SECRET_PROMPT =
    "diff --git a/x b/x\n+const apiKey = 'ghp_" + "a".repeat(24) + "'";

  test("logs provider/model/usage/latency and no prompt text at all", async () => {
    const lines: string[] = [];
    const { fetchImpl } = scriptedFetch([async () => jsonResponse(okBody())]);
    const client = createHttpAiClient({
      baseUrl: "http://x",
      fetchImpl,
      sink: (line) => lines.push(line),
    });
    await client.chat({
      stage: "AI_COMMITS",
      messages: [
        { role: "system", content: "you are an engineer" },
        { role: "user", content: SECRET_PROMPT },
      ],
    });

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] ?? "{}");
    expect(entry).toMatchObject({
      component: "ai",
      stage: "AI_COMMITS",
      attempt: 1,
      outcome: "ok",
      provider: "deepseek",
      model: "deepseek-chat",
      promptTokens: 1,
      completionTokens: 2,
      totalTokens: 3,
      latencyMs: 42,
    });
    const whole = lines.join("\n");
    expect(whole).not.toContain("diff --git");
    expect(whole).not.toContain("ghp_");
    expect(whole).not.toContain("you are an engineer");
  });

  test("a failed attempt logs the outcome only, never a response body", async () => {
    const lines: string[] = [];
    const { fetchImpl } = scriptedFetch([
      async () => jsonResponse({ success: false, error: "ghp_" + "b".repeat(24) }),
    ]);
    const client = createHttpAiClient({
      baseUrl: "http://x",
      fetchImpl,
      sink: (line) => lines.push(line),
    });
    await client.chat(REQUEST).catch(() => undefined);

    expect(lines).toHaveLength(2);
    expect(lines.join("\n")).not.toContain("ghp_");
    expect(JSON.parse(lines[1] ?? "{}").outcome).toBe("service-error");
  });
});
