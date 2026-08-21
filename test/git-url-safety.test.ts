/**
 * TASK-003 DoD: `urlSafety` rejects `git@`, `ssh://`, `file://`, and a
 * private-range host when `ALLOW_PRIVATE_GIT_HOSTS=false`.
 *
 * DNS is injected — no test here touches the network.
 */

import { describe, expect, test } from "bun:test";
import {
  assertSafeRepoUrl,
  isPrivateAddress,
  parseRepoUrl,
  RepoUrlError,
  type HostLookup,
} from "../src/git/urlSafety.ts";

const publicLookup: HostLookup = async () => [
  { address: "93.184.216.34", family: 4 },
];
const privateLookup: HostLookup = async () => [
  { address: "10.4.0.7", family: 4 },
];

function safe(url: string, allowPrivateHosts = false, lookup = publicLookup) {
  return assertSafeRepoUrl(url, { allowPrivateHosts, lookup });
}

describe("scheme gate", () => {
  test("accepts http and https", async () => {
    expect((await safe("https://github.com/a/b.git")).protocol).toBe("https:");
    expect((await safe("http://gitlab.example.com/a/b.git")).protocol).toBe("http:");
  });

  test("rejects git@ scp syntax", async () => {
    await expect(safe("git@github.com:a/b.git")).rejects.toBeInstanceOf(RepoUrlError);
  });

  test("rejects ssh://", async () => {
    await expect(safe("ssh://git@github.com/a/b.git")).rejects.toThrow(/http/i);
  });

  test("rejects file://", async () => {
    await expect(safe("file:///tmp/repo")).rejects.toThrow(/http/i);
  });

  test("rejects a bare path", async () => {
    await expect(safe("/tmp/repo")).rejects.toBeInstanceOf(RepoUrlError);
  });
});

describe("userinfo gate (TASK-005 rework, SPEC-001 2026-08-21)", () => {
  test("rejects user:password@ and never returns the URL", async () => {
    const url = "https://x-access-token:ghp_TESTTOKEN0123456789abcdef@github.com/o/r.git";
    // `parseRepoUrl` is the synchronous half the validator calls…
    expect(() => parseRepoUrl(url)).toThrow(RepoUrlError);
    try {
      parseRepoUrl(url);
      throw new Error("parseRepoUrl accepted a credentialed URL");
    } catch (error) {
      expect((error as RepoUrlError).reason).toBe("USERINFO");
      // The secret is never quoted back in the thrown message.
      expect((error as Error).message).not.toContain("ghp_TESTTOKEN0123456789abcdef");
    }
    // …and the run-time half inherits the rule for free.
    await expect(safe(url)).rejects.toBeInstanceOf(RepoUrlError);
  });

  test("rejects a username with no password", async () => {
    await expect(safe("https://someuser@github.com/o/r.git")).rejects.toThrow(
      /username or password/i,
    );
  });

  test("rejects an empty username with a password", async () => {
    await expect(safe("https://:s3cret@github.com/o/r.git")).rejects.toThrow(
      /username or password/i,
    );
  });

  test("an ordinary URL with an @ in the path is still accepted", async () => {
    expect((await safe("https://github.com/o/r%40b.git")).username).toBe("");
  });
});

describe("private address gate", () => {
  test("rejects a literal loopback address", async () => {
    await expect(safe("http://127.0.0.1:3000/a.git")).rejects.toThrow(/private/i);
  });

  test("rejects localhost without a DNS round trip", async () => {
    const exploding: HostLookup = async () => {
      throw new Error("DNS must not be consulted for localhost");
    };
    await expect(safe("http://localhost/a.git", false, exploding)).rejects.toThrow(
      /private/i,
    );
  });

  test("rejects each private range", async () => {
    for (const host of ["10.0.0.5", "172.16.3.4", "192.168.1.10", "169.254.1.1"]) {
      await expect(safe(`http://${host}/a.git`)).rejects.toThrow(/private/i);
    }
  });

  test("rejects a public name that resolves into a private range", async () => {
    await expect(
      safe("https://internal.example.com/a.git", false, privateLookup),
    ).rejects.toThrow(/private/i);
  });

  test("allows a private host when ALLOW_PRIVATE_GIT_HOSTS is true", async () => {
    const url = await safe("http://192.168.1.10/a.git", true);
    expect(url.hostname).toBe("192.168.1.10");
  });

  test("classifies IPv6 loopback and ULA as private", () => {
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("fd00::1")).toBe(true);
    expect(isPrivateAddress("fe80::1")).toBe(true);
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("2606:4700::1111")).toBe(false);
  });
});
