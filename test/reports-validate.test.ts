/**
 * TASK-005 §1 — the `POST /api/reports` validation matrix.
 *
 * The two agreed bounds are asserted **at** the boundary, not near it: the
 * frontend ships a check against each and the two must agree by specification
 * (TASK-005 §1, added by Sober at the TASK-007 review).
 */

process.env.DATABASE_URL ??= "postgres://user:pw@127.0.0.1:5432/code_report_test";
process.env.SESSION_SECRET ??= "test-session-secret-not-a-real-one";

import { describe, expect, test } from "bun:test";
import {
  MAX_EXTRA_CONTEXT_CHARS,
  MAX_SPAN_DAYS,
  validateCreateReport,
} from "../src/reports/validate.ts";

const VALID = {
  repoUrl: "https://github.com/develyst1/smart-scheduler-front.git",
  dateFrom: "2026-08-01",
  dateTo: "2026-08-07",
  language: "th",
};

function issues(body: unknown): Record<string, string> {
  const result = validateCreateReport(body);
  if (result.ok) throw new Error("expected the body to be rejected");
  return Object.fromEntries(
    Object.entries(result.issues).map(([field, { issue }]) => [field, issue]),
  );
}

function accepted(body: unknown) {
  const result = validateCreateReport(body);
  if (!result.ok) {
    throw new Error(`expected acceptance, got ${JSON.stringify(result.issues)}`);
  }
  return result.value;
}

describe("the happy body", () => {
  test("is accepted and trimmed, with the optional fields absent", () => {
    const value = accepted({ ...VALID, repoUrl: `  ${VALID.repoUrl}  ` });
    expect(value.repoUrl).toBe(VALID.repoUrl);
    expect(value.pat).toBeUndefined();
    expect(value.branch).toBeUndefined();
    expect(value.author).toBeUndefined();
    expect(value.extraContext).toBeUndefined();
    expect(value.language).toBe("th");
  });

  test("a single day is dateFrom === dateTo", () => {
    const value = accepted({ ...VALID, dateFrom: "2026-08-07", dateTo: "2026-08-07" });
    expect(value.dateFrom).toBe(value.dateTo);
  });
});

describe("repoUrl", () => {
  test("is required", () => {
    const { repoUrl, ...rest } = VALID;
    expect(issues(rest)).toEqual({ repoUrl: "REQUIRED" });
  });

  test("an empty string is REQUIRED, not INVALID_URL", () => {
    expect(issues({ ...VALID, repoUrl: "   " })).toEqual({ repoUrl: "REQUIRED" });
  });

  for (const rejected of [
    "git@github.com:develyst1/smart-scheduler-front.git",
    "ssh://git@github.com/develyst1/x.git",
    "file:///etc/passwd",
    "not a url at all",
    // A credential in the wrong field — SPEC-001 2026-08-21, TASK-005 rework.
    "https://x-access-token:ghp_TESTTOKEN0123456789abcdef@github.com/o/r.git",
    "https://someuser@github.com/o/r.git",
  ]) {
    test(`rejects ${rejected}`, () => {
      expect(issues({ ...VALID, repoUrl: rejected })).toEqual({
        repoUrl: "INVALID_URL",
      });
    });
  }

  test("plain http is accepted — the scheme gate allows both", () => {
    expect(accepted({ ...VALID, repoUrl: "http://example.com/x.git" }).repoUrl).toBe(
      "http://example.com/x.git",
    );
  });
});

describe("dates", () => {
  test("both are required", () => {
    expect(issues({ repoUrl: VALID.repoUrl, language: "th" })).toEqual({
      dateFrom: "REQUIRED",
      dateTo: "REQUIRED",
    });
  });

  test("a non-YYYY-MM-DD date is rejected", () => {
    expect(issues({ ...VALID, dateFrom: "01/08/2026" })).toEqual({
      dateFrom: "INVALID_DATE",
    });
  });

  test("a date that is not a real calendar day is rejected", () => {
    expect(issues({ ...VALID, dateFrom: "2026-02-31" })).toEqual({
      dateFrom: "INVALID_DATE",
    });
  });

  test("dateTo before dateFrom is rejected", () => {
    expect(issues({ ...VALID, dateFrom: "2026-08-07", dateTo: "2026-08-01" })).toEqual({
      dateTo: "DATE_ORDER",
    });
  });

  test("a span of exactly 366 days is ACCEPTED (the bound is exclusive)", () => {
    // 2025-08-20 + 366 days = 2026-08-21.
    const value = accepted({
      ...VALID,
      dateFrom: "2025-08-20",
      dateTo: "2026-08-21",
    });
    const span =
      (Date.parse(`${value.dateTo}T00:00:00Z`) -
        Date.parse(`${value.dateFrom}T00:00:00Z`)) /
      86_400_000;
    expect(span).toBe(MAX_SPAN_DAYS);
  });

  test("a span of 367 days is rejected", () => {
    expect(
      issues({ ...VALID, dateFrom: "2025-08-20", dateTo: "2026-08-22" }),
    ).toEqual({ dateTo: "SPAN_TOO_LONG" });
  });
});

describe("language", () => {
  test("is required", () => {
    const { language, ...rest } = VALID;
    expect(issues(rest)).toEqual({ language: "REQUIRED" });
  });

  test("anything but th|en is rejected", () => {
    expect(issues({ ...VALID, language: "fr" })).toEqual({
      language: "INVALID_LANGUAGE",
    });
  });
});

describe("extraContext is counted in UTF-16 code units", () => {
  test("exactly 8000 code units is accepted", () => {
    const value = accepted({ ...VALID, extraContext: "a".repeat(8000) });
    expect(value.extraContext).toHaveLength(MAX_EXTRA_CONTEXT_CHARS);
  });

  test("8001 code units is rejected", () => {
    expect(issues({ ...VALID, extraContext: "a".repeat(8001) })).toEqual({
      extraContext: "TOO_LONG",
    });
  });

  test("4000 emoji are 8000 code units and are ACCEPTED", () => {
    // Each of these is one codepoint and two UTF-16 code units. Counting
    // codepoints here would make the bound 8000 emoji — input the frontend's
    // `.length` counter refuses to send.
    const text = "😀".repeat(4000);
    expect([...text]).toHaveLength(4000);
    expect(text).toHaveLength(8000);
    expect(accepted({ ...VALID, extraContext: text }).extraContext).toBe(text);
  });

  test("4001 emoji are 8002 code units and are REJECTED", () => {
    const text = "😀".repeat(4001);
    expect([...text]).toHaveLength(4001);
    expect(issues({ ...VALID, extraContext: text })).toEqual({
      extraContext: "TOO_LONG",
    });
  });
});

describe("types", () => {
  test("a non-object body is rejected", () => {
    expect(issues("hello")).toEqual({ repoUrl: "REQUIRED" });
  });

  test("a numeric branch is a type error, not a coercion", () => {
    expect(issues({ ...VALID, branch: 7 })).toEqual({ branch: "INVALID_TYPE" });
  });

  test("several bad fields are reported together", () => {
    expect(
      issues({ repoUrl: "git@x:y.git", dateFrom: "nope", dateTo: "nope", language: "de" }),
    ).toEqual({
      repoUrl: "INVALID_URL",
      dateFrom: "INVALID_DATE",
      dateTo: "INVALID_DATE",
      language: "INVALID_LANGUAGE",
    });
  });
});
