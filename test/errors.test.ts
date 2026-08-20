import { describe, expect, test } from "bun:test";
import {
  ERROR_CODES,
  LANGUAGES,
  errorEnvelope,
  errorMessage,
  languageFromAcceptHeader,
} from "../src/errors/index.ts";

describe("error message table", () => {
  test("covers every SPEC-001 error code in every language", () => {
    // SPEC-001 "Error codes (single source of truth)" — all ten.
    expect([...(ERROR_CODES as readonly string[])].sort()).toEqual(
      [
        "AI_UNAVAILABLE",
        "AUTH_REQUIRED",
        "BRANCH_NOT_FOUND",
        "CLONE_FAILED",
        "CLONE_TIMEOUT",
        "INTERNAL",
        "INVALID_CREDENTIALS",
        "REPO_AUTH_FAILED",
        "REPO_NOT_FOUND",
        "VALIDATION_ERROR",
      ].sort(),
    );

    for (const code of ERROR_CODES) {
      for (const language of LANGUAGES) {
        const message = errorMessage(code, language);
        expect(message.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test("th and en text differ for every code", () => {
    for (const code of ERROR_CODES) {
      expect(errorMessage(code, "th")).not.toBe(errorMessage(code, "en"));
    }
  });

  test("Thai text is actually Thai, English text carries no Thai", () => {
    const thai = /[฀-๿]/;
    for (const code of ERROR_CODES) {
      expect(errorMessage(code, "th")).toMatch(thai);
      expect(errorMessage(code, "en")).not.toMatch(thai);
    }
  });

  test("BRANCH_NOT_FOUND names the branch (SPEC-001 error table)", () => {
    expect(errorMessage("BRANCH_NOT_FOUND", "en", { branch: "develop" })).toContain(
      "develop",
    );
    expect(errorMessage("BRANCH_NOT_FOUND", "th", { branch: "develop" })).toContain(
      "develop",
    );
  });

  test("CLONE_FAILED carries the sanitized detail when given", () => {
    expect(errorMessage("CLONE_FAILED", "en", { detail: "remote hung up" })).toContain(
      "remote hung up",
    );
  });

  test("defaults to Thai", () => {
    expect(errorMessage("AUTH_REQUIRED")).toBe(errorMessage("AUTH_REQUIRED", "th"));
  });
});

describe("languageFromAcceptHeader", () => {
  test.each([
    [undefined, "th"],
    ["en", "en"],
    ["en-US,en;q=0.9", "en"],
    ["th-TH,th;q=0.9,en;q=0.8", "th"],
    ["fr-FR,fr;q=0.9", "th"],
    ["fr,en;q=0.8", "en"],
  ] as const)("%p -> %p", (header, expected) => {
    expect(languageFromAcceptHeader(header)).toBe(expected);
  });
});

describe("errorEnvelope", () => {
  test("has the SPEC-001 shape", () => {
    expect(errorEnvelope("INVALID_CREDENTIALS", "en")).toEqual({
      error: {
        code: "INVALID_CREDENTIALS",
        message: "Wrong username or password.",
      },
    });
  });
});
