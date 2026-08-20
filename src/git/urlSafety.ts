/**
 * Repo URL safety (TASK-003 §2, SPEC-001 "Non-functional → Repo URL safety").
 *
 * Two independent gates:
 *   1. scheme — `http`/`https` only. `git@host:path`, `ssh://`, `file://` and
 *      everything else are rejected before any process is spawned.
 *   2. address — a host that resolves to a loopback / link-local / private
 *      range is rejected unless `ALLOW_PRIVATE_GIT_HOSTS=true` (a self-hosted
 *      GitLab on the LAN is legitimate, so it is configurable, off by default).
 *
 * DNS resolution is injected so unit tests never touch the network.
 */

import { lookup as dnsLookup } from "node:dns/promises";

export type ResolvedAddress = { address: string; family: number };
export type HostLookup = (hostname: string) => Promise<ResolvedAddress[]>;

export class RepoUrlError extends Error {
  /** Machine-readable reason, for the caller's validation map. */
  readonly reason: "SCHEME" | "MALFORMED" | "PRIVATE_HOST" | "UNRESOLVABLE";

  constructor(reason: RepoUrlError["reason"], message: string) {
    super(message);
    this.name = "RepoUrlError";
    this.reason = reason;
  }
}

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/** Hostnames that are loopback by definition, with no DNS round trip. */
function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host.endsWith(".localhost");
}

function parseIpv4(address: string): number[] | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const value = Number(part);
    if (value > 255) return undefined;
    octets.push(value);
  }
  return octets;
}

/** Loopback, link-local, private, unspecified and carrier-grade NAT ranges. */
function isPrivateIpv4(octets: number[]): boolean {
  const [a = 0, b = 0] = octets;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // 127/8 loopback
  if (a === 169 && b === 254) return true; // 169.254/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  return false;
}

function isPrivateIpv6(address: string): boolean {
  const host = address.toLowerCase().split("%")[0] ?? "";
  if (host === "::" || host === "::1") return true; // unspecified / loopback

  // IPv4-mapped and IPv4-compatible forms carry an embedded v4 address.
  const mapped = host.match(/^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
  const embedded = mapped?.[1];
  if (embedded !== undefined) {
    const octets = parseIpv4(embedded);
    return octets === undefined ? true : isPrivateIpv4(octets);
  }

  if (host.startsWith("fe8") || host.startsWith("fe9")) return true; // fe80::/10
  if (host.startsWith("fea") || host.startsWith("feb")) return true;
  if (host.startsWith("fc") || host.startsWith("fd")) return true; // fc00::/7 ULA
  return false;
}

/** True for an address inside a loopback / link-local / private range. */
export function isPrivateAddress(address: string): boolean {
  const octets = parseIpv4(address);
  if (octets !== undefined) return isPrivateIpv4(octets);
  return isPrivateIpv6(address);
}

/**
 * Validate the URL the user typed. Returns the parsed URL on success.
 *
 * The returned href is what gets handed to `git` — never the raw string, so a
 * `\n` or a leading space cannot survive parsing into the argv array.
 */
export async function assertSafeRepoUrl(
  rawUrl: string,
  options: { allowPrivateHosts: boolean; lookup?: HostLookup | undefined },
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new RepoUrlError(
      "MALFORMED",
      "Repository address must be a full http(s) URL.",
    );
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new RepoUrlError(
      "SCHEME",
      `Only http and https repository addresses are supported (got "${url.protocol.replace(":", "")}").`,
    );
  }

  if (options.allowPrivateHosts) return url;

  // Strip the brackets an IPv6 literal carries in a URL host.
  const hostname = url.hostname.replace(/^\[|\]$/g, "");

  if (isLoopbackHostname(hostname)) {
    throw new RepoUrlError(
      "PRIVATE_HOST",
      "Repository addresses on this machine or a private network are not allowed.",
    );
  }

  if (parseIpv4(hostname) !== undefined || hostname.includes(":")) {
    if (isPrivateAddress(hostname)) {
      throw new RepoUrlError(
        "PRIVATE_HOST",
        "Repository addresses on this machine or a private network are not allowed.",
      );
    }
    return url;
  }

  const lookup = options.lookup ?? defaultLookup;
  let addresses: ResolvedAddress[];
  try {
    addresses = await lookup(hostname);
  } catch {
    throw new RepoUrlError(
      "UNRESOLVABLE",
      "Repository address could not be resolved.",
    );
  }

  if (addresses.length === 0) {
    throw new RepoUrlError(
      "UNRESOLVABLE",
      "Repository address could not be resolved.",
    );
  }

  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new RepoUrlError(
        "PRIVATE_HOST",
        "Repository addresses on this machine or a private network are not allowed.",
      );
    }
  }

  return url;
}

async function defaultLookup(hostname: string): Promise<ResolvedAddress[]> {
  const results = await dnsLookup(hostname, { all: true });
  return results.map(({ address, family }) => ({ address, family }));
}
