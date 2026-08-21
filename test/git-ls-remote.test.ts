/**
 * TASK-017 §1 — the `ls-remote` module: argv discipline, the `--symref` parse,
 * and the reused SPEC-001 failure mapping.
 *
 * No network and no remote: every test drives the module through the same
 * `runner` seam `cloneRepository` has.
 */

import { describe, expect, test } from "bun:test";
import { authorizationHeader, buildCloneArgs } from "../src/git/clone.ts";
import {
  buildLsRemoteArgs,
  listRemoteBranches,
  parseLsRemote,
} from "../src/git/lsRemote.ts";
import { redactAll } from "../src/git/redact.ts";
import type { GitRun, GitRunner } from "../src/git/run.ts";
import type { HostLookup } from "../src/git/urlSafety.ts";

const DUMMY_PAT = "ghp_0123456789abcdefghijklmnopqrstuvwx";
const BASE64_CREDENTIAL = authorizationHeader(DUMMY_PAT).slice(
  "Authorization: Basic ".length,
);
const PUBLIC_LOOKUP: HostLookup = async () => [
  { address: "93.184.216.34", family: 4 },
];
const REPO_URL = "https://example.com/team/app.git";

function fakeRunner(
  result: Partial<GitRun>,
  seen?: { args: string[]; secrets: (string | undefined)[] }[],
): GitRunner {
  return async (args, options) => {
    seen?.push({ args, secrets: options?.secrets ?? [] });
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...result };
  };
}

describe("buildLsRemoteArgs", () => {
  test("puts the token in an extraHeader and never in the URL", () => {
    const args = buildLsRemoteArgs(REPO_URL, { pat: DUMMY_PAT });
    expect(args).toContain(`http.extraHeader=${authorizationHeader(DUMMY_PAT)}`);
    const url = args[args.length - 1];
    expect(url).toBe(REPO_URL);
    expect(url).not.toContain(DUMMY_PAT);
    expect(url).not.toContain("@");
  });

  test("the same discipline the clone uses, and no directory argument", () => {
    const args = buildLsRemoteArgs(REPO_URL);
    expect(args.slice(0, 4)).toEqual([
      "-c",
      "credential.helper=",
      "-c",
      "core.askPass=",
    ]);
    expect(args.join(" ")).toContain("ls-remote --symref --heads");
    expect(args.join(" ")).not.toContain("extraHeader");
    // A directory would be the argument after the URL; there is none.
    expect(args[args.length - 1]).toBe(REPO_URL);
  });

  test("both endpoints keep the token out of the URL argument", () => {
    // The clone half of the same rule, asserted here so the pair is one test.
    const clone = buildCloneArgs(REPO_URL, "/tmp/x", { pat: DUMMY_PAT });
    expect(clone[clone.length - 2]).toBe(REPO_URL);
    expect(clone.join(" ")).toContain(
      `http.extraHeader=${authorizationHeader(DUMMY_PAT)}`,
    );
  });
});

describe("parseLsRemote", () => {
  const OUTPUT =
    "ref: refs/heads/main\tHEAD\n" +
    "1111111111111111111111111111111111111111\tHEAD\n" +
    "1111111111111111111111111111111111111111\trefs/heads/main\n" +
    "2222222222222222222222222222222222222222\trefs/heads/develop\n" +
    "3333333333333333333333333333333333333333\trefs/heads/feature/one\n";

  test("heads are short names in git's own order, HEAD is not one of them", () => {
    expect(parseLsRemote(OUTPUT).branches).toEqual([
      "main",
      "develop",
      "feature/one",
    ]);
  });

  test("defaultBranch comes from the --symref line", () => {
    expect(parseLsRemote(OUTPUT).defaultBranch).toBe("main");
  });

  test("a symref target that is not among the heads gives null, not 'main'", () => {
    const output =
      "ref: refs/heads/main\tHEAD\n" +
      "2222222222222222222222222222222222222222\trefs/heads/develop\n";
    expect(parseLsRemote(output)).toEqual({
      branches: ["develop"],
      defaultBranch: null,
    });
  });

  test("no symref line at all is still a list", () => {
    const output = "2222222222222222222222222222222222222222\trefs/heads/develop\n";
    expect(parseLsRemote(output)).toEqual({
      branches: ["develop"],
      defaultBranch: null,
    });
  });

  test("an empty remote is an empty list, not an error", () => {
    expect(parseLsRemote("")).toEqual({ branches: [], defaultBranch: null });
  });
});

describe("listRemoteBranches", () => {
  test("an unsafe URL is refused before git is ever started", async () => {
    for (const url of [
      "git@github.com:o/r.git",
      "ssh://git@github.com/o/r.git",
      "file:///etc/passwd",
      `https://x-access-token:${DUMMY_PAT}@github.com/o/r.git`,
    ]) {
      let started = false;
      const promise = listRemoteBranches({
        repoUrl: url,
        allowPrivateHosts: false,
        lookup: PUBLIC_LOOKUP,
        runner: async () => {
          started = true;
          return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
        },
      });
      await expect(promise).rejects.toThrow();
      expect(started).toBe(false);
    }
  });

  test("a timeout becomes CLONE_TIMEOUT", async () => {
    const promise = listRemoteBranches({
      repoUrl: REPO_URL,
      allowPrivateHosts: false,
      lookup: PUBLIC_LOOKUP,
      runner: fakeRunner({ exitCode: 143, timedOut: true }),
    });
    await expect(promise).rejects.toMatchObject({ code: "CLONE_TIMEOUT" });
  });

  test("the SPEC-001 failure mapping is classifyCloneFailure, reused", async () => {
    const cases: [string, string][] = [
      ["remote: Authentication failed for 'https://example.com/'", "REPO_AUTH_FAILED"],
      ["remote: 404 not found", "REPO_AUTH_FAILED"],
      [
        "fatal: repository 'https://example.com/x/' does not appear to be a git repository",
        "REPO_NOT_FOUND",
      ],
      ["fatal: unable to access: SSL certificate problem", "CLONE_FAILED"],
    ];
    for (const [stderr, code] of cases) {
      const promise = listRemoteBranches({
        repoUrl: REPO_URL,
        allowPrivateHosts: false,
        lookup: PUBLIC_LOOKUP,
        runner: fakeRunner({ exitCode: 128, stderr }),
      });
      await expect(promise).rejects.toMatchObject({ code });
    }
  });

  test("the runner is handed the token AND the base64 credential to redact", async () => {
    const seen: { args: string[]; secrets: (string | undefined)[] }[] = [];
    await listRemoteBranches({
      repoUrl: REPO_URL,
      pat: DUMMY_PAT,
      allowPrivateHosts: false,
      lookup: PUBLIC_LOOKUP,
      runner: fakeRunner({ stdout: "" }, seen),
    });
    expect(seen[0]?.secrets).toContain(DUMMY_PAT);
    expect(seen[0]?.secrets).toContain(BASE64_CREDENTIAL);
  });

  test("a PAT-bearing failure comes back redacted, token and base64 both", async () => {
    // The runner here does exactly what `runGit` does with `options.secrets` —
    // it hands the output to the real `redactAll` — so this measures the
    // wiring, not a copy of it.
    const promise = listRemoteBranches({
      repoUrl: REPO_URL,
      pat: DUMMY_PAT,
      allowPrivateHosts: false,
      lookup: PUBLIC_LOOKUP,
      runner: async (_args, options) => ({
        exitCode: 128,
        stdout: "",
        stderr: redactAll(
          `fatal: unable to access using ${DUMMY_PAT} / ${BASE64_CREDENTIAL}`,
          options?.secrets ?? [],
        ),
        timedOut: false,
      }),
    });
    const error = (await promise.catch((e: unknown) => e)) as {
      code: string;
      detail: string;
    };
    expect(error.code).toBe("CLONE_FAILED");
    expect(error.detail).not.toContain(DUMMY_PAT);
    expect(error.detail).not.toContain(BASE64_CREDENTIAL);
    expect(error.detail).toContain("***REDACTED***");
  });

  test("a successful run returns the parsed list", async () => {
    const result = await listRemoteBranches({
      repoUrl: REPO_URL,
      allowPrivateHosts: false,
      lookup: PUBLIC_LOOKUP,
      runner: fakeRunner({
        stdout:
          "ref: refs/heads/main\tHEAD\n" +
          "1111111111111111111111111111111111111111\trefs/heads/main\n",
      }),
    });
    expect(result).toEqual({ branches: ["main"], defaultBranch: "main" });
  });
});
