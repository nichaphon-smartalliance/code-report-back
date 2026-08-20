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

describe("describeConfig", () => {
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
