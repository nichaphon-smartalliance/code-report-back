/**
 * TASK-003 DoD: a `ghp_` / `glpat-` / `Authorization:` string and the run token
 * never survive into a returned error message or a log line.
 */

import { describe, expect, test } from "bun:test";
import { REDACTED, redact, redactAll } from "../src/git/redact.ts";
import { authorizationHeader } from "../src/git/clone.ts";
import { GitLayerError } from "../src/git/errors.ts";
import { runGit } from "../src/git/run.ts";
import { makeTempDir, removeDir } from "./fixtures/gitRepo.ts";
import { join } from "node:path";

const GITHUB_PAT = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const GITLAB_PAT = "glpat-ABCDEFGHIJKLMNOPQRST_-x";

describe("redact", () => {
  test("removes GitHub token shapes", () => {
    const out = redact(`fatal: bad credentials ${GITHUB_PAT} while cloning`);
    expect(out).not.toContain(GITHUB_PAT);
    expect(out).toContain(REDACTED);
  });

  test("removes every gh?_ prefix variant", () => {
    for (const prefix of ["ghp", "gho", "ghu", "ghs", "ghr"]) {
      const token = `${prefix}_${"a".repeat(30)}`;
      expect(redact(`x ${token} y`)).not.toContain(token);
    }
  });

  test("removes GitLab token shapes", () => {
    expect(redact(`token=${GITLAB_PAT}`)).not.toContain(GITLAB_PAT);
  });

  test("removes an Authorization header", () => {
    const header = authorizationHeader(GITHUB_PAT);
    const out = redact(`http.extraHeader=${header}`);
    expect(out).not.toContain(GITHUB_PAT);
    expect(out).toContain(REDACTED);
  });

  test("removes the run token even when it matches no known shape", () => {
    const odd = "not-a-github-shape-but-still-secret";
    const out = redact(`remote: rejected ${odd}`, odd);
    expect(out).not.toContain(odd);
    expect(out).toContain(REDACTED);
  });

  test("redacts the base64 credential derived from the token", () => {
    const header = authorizationHeader(GITHUB_PAT);
    const base64 = header.slice("Authorization: Basic ".length);
    // The blob decodes straight back to the PAT, so it is a secret too.
    expect(Buffer.from(base64, "base64").toString("utf8")).toContain(GITHUB_PAT);
    const out = redactAll(`extraHeader value was ${base64}`, [GITHUB_PAT, base64]);
    expect(out).not.toContain(base64);
  });

  test("leaves ordinary text alone", () => {
    const message = "fatal: repository 'https://example.com/x.git' not found";
    expect(redact(message)).toBe(message);
  });

  test("a short run token is not used as a literal pattern", () => {
    // Redacting "ab" would blank out unrelated words and hide the real error.
    expect(redact("a readable message", "ab")).toBe("a readable message");
  });

  test("the error a failure produces carries no token", () => {
    const raw = `fatal: could not read Username: ${GITHUB_PAT}`;
    const error = new GitLayerError("CLONE_FAILED", { detail: redact(raw) });
    expect(error.message).not.toContain(GITHUB_PAT);
    expect(error.detail).not.toContain(GITHUB_PAT);
  });
});

describe("runGit output", () => {
  test("git's own stderr is redacted before the caller sees it", async () => {
    const root = await makeTempDir();
    try {
      // git echoes the path it could not enter — and the path holds a token.
      const missing = join(root, GITHUB_PAT, "repo");
      const result = await runGit(["-C", missing, "status"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).not.toContain(GITHUB_PAT);
      expect(result.stderr).toContain(REDACTED);
    } finally {
      await removeDir(root);
    }
  }, 30_000);
});
