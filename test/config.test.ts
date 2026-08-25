import { describe, expect, test } from "bun:test";
import { ConfigError, describeConfig, loadConfig } from "../src/config.ts";

const MINIMAL = {
  DATABASE_URL: "postgres://u:secretpw@localhost:5432/code_report",
  SESSION_SECRET: "session-secret-value",
};

describe("loadConfig", () => {
  test("fails fast when DATABASE_URL is missing", () => {
    expect(() => loadConfig({ SESSION_SECRET: "x" })).toThrow(ConfigError);
    expect(() => loadConfig({ SESSION_SECRET: "x" })).toThrow(/DATABASE_URL/);
  });

  test("fails fast when SESSION_SECRET is missing", () => {
    expect(() => loadConfig({ DATABASE_URL: "x" })).toThrow(/SESSION_SECRET/);
  });

  test("treats a blank required var as missing", () => {
    expect(() => loadConfig({ ...MINIMAL, SESSION_SECRET: "   " })).toThrow(
      /SESSION_SECRET/,
    );
  });

  test("applies the documented defaults", () => {
    const config = loadConfig(MINIMAL);
    expect(config.PORT).toBe(8080);
    expect(config.REPORT_TIMEZONE).toBe("Asia/Bangkok");
    expect(config.AI_API_CENTER_URL).toBe("http://localhost:3009");
    expect(config.AI_API_CENTER_TOKEN).toBeUndefined();
    expect(config.ALLOW_PRIVATE_GIT_HOSTS).toBe(false);
    expect(config.MAX_CONCURRENT_JOBS).toBe(2);
    expect(config.SEED_USERS_FILE).toBeUndefined();
  });

  test("overrides the defaults from the environment", () => {
    const config = loadConfig({
      ...MINIMAL,
      PORT: "9100",
      REPORT_TIMEZONE: "UTC",
      ALLOW_PRIVATE_GIT_HOSTS: "true",
      MAX_CONCURRENT_JOBS: "5",
    });
    expect(config.PORT).toBe(9100);
    expect(config.REPORT_TIMEZONE).toBe("UTC");
    expect(config.ALLOW_PRIVATE_GIT_HOSTS).toBe(true);
    expect(config.MAX_CONCURRENT_JOBS).toBe(5);
  });

  test("rejects a non-numeric PORT and a non-boolean flag", () => {
    expect(() => loadConfig({ ...MINIMAL, PORT: "http" })).toThrow(/PORT/);
    expect(() =>
      loadConfig({ ...MINIMAL, ALLOW_PRIVATE_GIT_HOSTS: "yes" }),
    ).toThrow(/ALLOW_PRIVATE_GIT_HOSTS/);
  });
});

describe("per-stage AI settings (SPEC-007 / TASK-025)", () => {
  test("applies the mandated per-stage model + max_tokens defaults", () => {
    const config = loadConfig(MINIMAL);
    expect(config.aiStages.AI_PROJECT).toEqual({
      model: "gpt-4.1-mini",
      maxTokens: 20000,
    });
    expect(config.aiStages.AI_COMMITS).toEqual({
      model: "gpt-4.1-mini",
      maxTokens: 20000,
    });
    expect(config.aiStages.AI_CURIOUSNESS).toEqual({
      model: "grok-4-latest",
      maxTokens: 50000,
    });
    expect(config.aiStages.AI_UNDERSTANDING).toEqual({
      model: "gpt-4.1",
      maxTokens: 40000,
    });
    expect(config.aiStages.AI_WRITING).toEqual({
      model: "gpt-4.1",
      maxTokens: 50000,
    });
    expect(config.aiCuriosityMaxIterations).toBe(5);
    expect(config.aiWritingMaxPasses).toBe(3);
  });

  test("reads per-stage overrides from the environment", () => {
    const config = loadConfig({
      ...MINIMAL,
      AI_PROJECT_MODEL: "deepseek-v4-pro",
      AI_PROJECT_MAX_TOKENS: "12000",
      AI_CURIOUSNESS_MAX_ITERATIONS: "8",
      AI_WRITING_MAX_PASSES: "2",
    });
    expect(config.aiStages.AI_PROJECT).toEqual({
      model: "deepseek-v4-pro",
      maxTokens: 12000,
    });
    expect(config.aiCuriosityMaxIterations).toBe(8);
    expect(config.aiWritingMaxPasses).toBe(2);
  });

  test("rejects an unknown model id for a stage", () => {
    expect(() =>
      loadConfig({ ...MINIMAL, AI_WRITING_MODEL: "gpt-9000" }),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({ ...MINIMAL, AI_WRITING_MODEL: "gpt-9000" }),
    ).toThrow(/AI_WRITING_MODEL/);
  });

  test("rejects a max_tokens above the assigned model's per-call cap", () => {
    // gpt-4.1-mini caps at 30000; 40000 must be fatal.
    expect(() =>
      loadConfig({ ...MINIMAL, AI_COMMITS_MAX_TOKENS: "40000" }),
    ).toThrow(/AI_COMMITS_MAX_TOKENS/);
    // The same budget is fine once the model's cap allows it.
    const ok = loadConfig({
      ...MINIMAL,
      AI_COMMITS_MODEL: "gpt-4.1",
      AI_COMMITS_MAX_TOKENS: "40000",
    });
    expect(ok.aiStages.AI_COMMITS).toEqual({
      model: "gpt-4.1",
      maxTokens: 40000,
    });
  });

  test("rejects a non-positive per-stage max_tokens", () => {
    expect(() =>
      loadConfig({ ...MINIMAL, AI_PROJECT_MAX_TOKENS: "0" }),
    ).toThrow(/AI_PROJECT_MAX_TOKENS/);
  });
});

describe("model-level fallback chain (SPEC-007 §Fallback / Req-7)", () => {
  test("defaults to deepseek-v4-pro,deepseek-v4-flash when absent", () => {
    expect(loadConfig(MINIMAL).fallbackModels).toEqual([
      "deepseek-v4-pro",
      "deepseek-v4-flash",
    ]);
  });

  test("an explicit empty value disables fallback (legal, not a ConfigError)", () => {
    expect(
      loadConfig({ ...MINIMAL, AI_FALLBACK_MODELS: "" }).fallbackModels,
    ).toEqual([]);
    // A blank/whitespace value is also disabled, never an error.
    expect(
      loadConfig({ ...MINIMAL, AI_FALLBACK_MODELS: "   " }).fallbackModels,
    ).toEqual([]);
  });

  test("parses an ordered chain, trimming whitespace and dropping blanks", () => {
    expect(
      loadConfig({
        ...MINIMAL,
        AI_FALLBACK_MODELS: " deepseek-v4-flash , , deepseek-v4-pro ",
      }).fallbackModels,
    ).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
  });

  test("rejects an unknown fallback model id with a fatal ConfigError", () => {
    expect(() =>
      loadConfig({ ...MINIMAL, AI_FALLBACK_MODELS: "deepseek-v4-pro,gpt-9000" }),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({ ...MINIMAL, AI_FALLBACK_MODELS: "deepseek-v4-pro,gpt-9000" }),
    ).toThrow(/AI_FALLBACK_MODELS/);
  });

  test("deepseek-v4-flash is now a valid stage model (cap 30000)", () => {
    const config = loadConfig({
      ...MINIMAL,
      AI_PROJECT_MODEL: "deepseek-v4-flash",
      AI_PROJECT_MAX_TOKENS: "30000",
    });
    expect(config.aiStages.AI_PROJECT).toEqual({
      model: "deepseek-v4-flash",
      maxTokens: 30000,
    });
    // ...but still capped at 30000: 30001 is fatal.
    expect(() =>
      loadConfig({
        ...MINIMAL,
        AI_PROJECT_MODEL: "deepseek-v4-flash",
        AI_PROJECT_MAX_TOKENS: "30001",
      }),
    ).toThrow(/AI_PROJECT_MAX_TOKENS/);
  });
});

describe("describeConfig", () => {
  test("reports the fallback chain (not a secret)", () => {
    expect(describeConfig(loadConfig(MINIMAL)).fallbackModels).toEqual([
      "deepseek-v4-pro",
      "deepseek-v4-flash",
    ]);
  });

  test("never exposes secret values", () => {
    const described = JSON.stringify(
      describeConfig(
        loadConfig({ ...MINIMAL, AI_API_CENTER_TOKEN: "ai-token-value" }),
      ),
    );
    expect(described).not.toContain("session-secret-value");
    expect(described).not.toContain("ai-token-value");
    expect(described).not.toContain("secretpw");
    expect(described).toContain("localhost:5432/code_report");
  });
});
