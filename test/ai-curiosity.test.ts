/**
 * SPEC-007 §Flow step 3 + D4, TASK-028 — the real AI_CURIOUSNESS loop.
 *
 * Everything runs against fakes: a scripted `AiClient` and a recording
 * `RepoInspector`. No network, no real repo. The loop's contract is: honour the
 * iteration cap, drive each action type through the inspector, exit early on
 * `done`/unparseable, feed results back as repository DATA, and send every call
 * with the configured AI_CURIOUSNESS model + budget.
 */

import { describe, expect, test } from "bun:test";
import { curiosityInvestigator, parseActions } from "../src/ai/curiosity.ts";
import type { CuriosityInput } from "../src/ai/pipeline.ts";
import type { ChatRequest } from "../src/ai/client.ts";
import { REPO_CLOSE, REPO_OPEN } from "../src/ai/prompts.ts";
import type { RepoInspector, SearchHit } from "../src/git/inspect.ts";
import { fakeAiClient, type FakeAiClient } from "./fixtures/aiClient.ts";
import { TEST_AI_STAGES, TEST_CURIOSITY_MAX_ITERATIONS } from "./fixtures/aiConfig.ts";

const fence = (json: string): string => "```json\n" + json + "\n```";
const DONE = fence('{"done": true}');

/** A `RepoInspector` that records what it was asked and returns canned answers. */
type RecordingInspector = RepoInspector & {
  listTreeCount: number;
  readPaths: string[];
  searchWords: string[];
};

function recordingInspector(
  answers: {
    tree?: string[];
    file?: (path: string) => string;
    hits?: SearchHit[];
  } = {},
): RecordingInspector {
  const inspector: RecordingInspector = {
    listTreeCount: 0,
    readPaths: [],
    searchWords: [],
    async listTree() {
      inspector.listTreeCount += 1;
      return answers.tree ?? ["src/index.ts", "README.md"];
    },
    async readFile(path: string) {
      inspector.readPaths.push(path);
      return answers.file ? answers.file(path) : `contents of ${path}`;
    },
    async search(word: string) {
      inspector.searchWords.push(word);
      return answers.hits ?? [];
    },
  };
  return inspector;
}

function input(
  overrides: Partial<CuriosityInput> & { client: FakeAiClient },
): CuriosityInput {
  return {
    profile: "A scheduling tool built in TypeScript.",
    batchSummaries: ["batch one summary", "batch two summary"],
    inspector: recordingInspector(),
    model: TEST_AI_STAGES.AI_CURIOUSNESS.model,
    maxTokens: TEST_AI_STAGES.AI_CURIOUSNESS.maxTokens,
    maxIterations: TEST_CURIOSITY_MAX_ITERATIONS,
    ...overrides,
  };
}

const promptOf = (request: ChatRequest): string =>
  request.messages.map((message) => message.content).join("\n");

describe("exit conditions", () => {
  test('{"done": true} on the first reply → one call, no inspection, empty findings', async () => {
    const client = fakeAiClient(() => DONE);
    const inspector = recordingInspector();
    const findings = await curiosityInvestigator.investigate(input({ client, inspector }));

    expect(findings).toBe("");
    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]!.stage).toBe("AI_CURIOUSNESS");
    expect(inspector.listTreeCount).toBe(0);
    expect(inspector.readPaths).toEqual([]);
  });

  test("an unparseable reply is a safe exit — no throw, empty findings, one call", async () => {
    const client = fakeAiClient(() => "The code looks fine to me; nothing to inspect.");
    const findings = await curiosityInvestigator.investigate(input({ client }));

    expect(findings).toBe("");
    expect(client.requests).toHaveLength(1);
  });

  test("a well-formed reply with no actionable request is a safe exit", async () => {
    // Valid JSON, valid shape, but every action is unknown/incomplete.
    const client = fakeAiClient(() =>
      fence('[{"action": "read_file"}, {"action": "delete_everything"}]'),
    );
    const inspector = recordingInspector();
    const findings = await curiosityInvestigator.investigate(input({ client, inspector }));

    expect(findings).toBe("");
    expect(client.requests).toHaveLength(1);
    expect(inspector.readPaths).toEqual([]);
  });

  test("honours the iteration cap when the model never says done", async () => {
    const client = fakeAiClient(() => fence('[{"action": "list_tree"}]'));
    await curiosityInvestigator.investigate(input({ client, maxIterations: 3 }));

    expect(client.requests).toHaveLength(3);
    expect(client.requests.every((request) => request.stage === "AI_CURIOUSNESS")).toBe(true);
  });
});

describe("the action protocol drives the inspector", () => {
  test("executes list_tree, read_file and search, then exits on done", async () => {
    const inspector = recordingInspector();
    let call = 0;
    const client = fakeAiClient(() => {
      call += 1;
      if (call === 1) {
        return fence(
          '[{"action": "list_tree"}, {"action": "read_file", "path": "src/grid.ts"}, ' +
            '{"action": "search", "word": "queue"}]',
        );
      }
      return DONE;
    });

    const findings = await curiosityInvestigator.investigate(input({ client, inspector }));

    expect(client.requests).toHaveLength(2);
    expect(inspector.listTreeCount).toBe(1);
    expect(inspector.readPaths).toEqual(["src/grid.ts"]);
    expect(inspector.searchWords).toEqual(["queue"]);
    // The gathered material is returned as the findings.
    expect(findings).toContain("read_file src/grid.ts");
    expect(findings).toContain("contents of src/grid.ts");
  });

  test("inspection results are fed back to the model wrapped as repository DATA", async () => {
    const inspector = recordingInspector({
      file: () => "export const grid = 1;",
    });
    let call = 0;
    const client = fakeAiClient(() => {
      call += 1;
      if (call === 1) return fence('[{"action": "read_file", "path": "src/grid.ts"}]');
      return DONE;
    });

    await curiosityInvestigator.investigate(input({ client, inspector }));

    expect(client.requests).toHaveLength(2);
    const secondPrompt = promptOf(client.requests[1]!);
    const open = secondPrompt.indexOf(REPO_OPEN);
    const close = secondPrompt.indexOf(REPO_CLOSE);
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);
    expect(secondPrompt.slice(open, close)).toContain("export const grid = 1;");
    // The first turn has nothing gathered yet.
    expect(promptOf(client.requests[0]!)).toContain("none yet");
  });

  test("a refused/missing path is still recorded and does not abort the loop", async () => {
    const inspector = recordingInspector({
      file: () => "…[path outside repository — refused]",
    });
    let call = 0;
    const client = fakeAiClient(() => {
      call += 1;
      if (call === 1) return fence('[{"action": "read_file", "path": "../../etc/passwd"}]');
      return DONE;
    });

    const findings = await curiosityInvestigator.investigate(input({ client, inspector }));
    expect(inspector.readPaths).toEqual(["../../etc/passwd"]);
    expect(findings).toContain("refused");
  });
});

describe("REQ-008 AC 3 — the configured model + budget reach every call body", () => {
  test("each AI_CURIOUSNESS call carries the injected model and max_tokens", async () => {
    const client = fakeAiClient(() => fence('[{"action": "list_tree"}]'));
    await curiosityInvestigator.investigate(
      input({ client, model: "grok-4-latest", maxTokens: 12345, maxIterations: 2 }),
    );

    expect(client.requests).toHaveLength(2);
    for (const request of client.requests) {
      expect(request.stage).toBe("AI_CURIOUSNESS");
      expect(request.model).toBe("grok-4-latest");
      expect(request.max_tokens).toBe(12345);
    }
  });
});

describe("parseActions (D4 vocabulary)", () => {
  test('{"done": true} → done', () => {
    expect(parseActions(DONE)).toEqual({ kind: "done" });
  });

  test("a bare JSON array (no fence) is accepted", () => {
    expect(parseActions('[{"action": "list_tree"}]')).toEqual({
      kind: "actions",
      actions: [{ type: "list_tree" }],
    });
  });

  test("an {actions:[...]} wrapper is accepted and paths/words are trimmed", () => {
    expect(
      parseActions(fence('{"actions": [{"action": "read_file", "path": " src/x.ts "}]}')),
    ).toEqual({ kind: "actions", actions: [{ type: "read_file", path: "src/x.ts" }] });
  });

  test("read_file without a path and unknown actions are dropped", () => {
    expect(
      parseActions(fence('[{"action": "read_file"}, {"action": "nope"}]')),
    ).toEqual({ kind: "stop" });
  });

  test("a done marker inside the array ends the batch after the valid actions", () => {
    expect(
      parseActions(fence('[{"action": "search", "word": "x"}, {"done": true}]')),
    ).toEqual({ kind: "actions", actions: [{ type: "search", word: "x" }] });
  });

  test("invalid JSON → stop (the safe exit)", () => {
    expect(parseActions("not json at all")).toEqual({ kind: "stop" });
  });
});
