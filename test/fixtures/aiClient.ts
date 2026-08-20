/**
 * The fake `AiClient` (SPEC-001 "Testing": the AI client is behind an
 * interface with a fake implementation; no unit test touches the network).
 *
 * It records every request it was given, so a test can assert on the prompts
 * themselves — which is where TASK-004's real requirements live.
 */

import type {
  AiClient,
  ChatRequest,
  ChatResult,
} from "../../src/ai/client.ts";

export type FakeAiClient = AiClient & {
  readonly requests: ChatRequest[];
  /** Concatenated content of every message in every request. */
  allPromptText(): string;
};

export function fakeAiClient(
  reply: (request: ChatRequest, index: number) => string = (request) =>
    `reply for ${request.stage}`,
): FakeAiClient {
  const requests: ChatRequest[] = [];
  return {
    requests,
    allPromptText() {
      return requests
        .flatMap((request) => request.messages.map((message) => message.content))
        .join("\n");
    },
    async chat(request: ChatRequest): Promise<ChatResult> {
      requests.push(request);
      return {
        provider: "deepseek",
        model: "fake-model",
        content: reply(request, requests.length - 1),
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        latency_ms: 5,
      };
    },
  };
}
