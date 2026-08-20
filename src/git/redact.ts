/**
 * PAT redactor (TASK-003 §1, SPEC-001 "Non-functional → PAT handling" 5).
 *
 * Write-once, depended-on-by-everything: **every** string this module logs,
 * throws, or returns as an error message goes through `redact()` first.
 *
 * The patterns are exactly the three SPEC-001 names, plus the run's own token
 * when the caller knows it. Nothing here ever stores a secret — the token is
 * an argument, not module state.
 */

export const REDACTED = "***REDACTED***";

/**
 * Token shapes SPEC-001 names explicitly. Global + case-sensitive: these
 * prefixes are lower-case by construction on both GitHub and GitLab.
 */
const TOKEN_PATTERNS: RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /glpat-[A-Za-z0-9_-]{20,}/g,
  // To end of line, case-insensitive (SPEC-001 amended 2026-08-20, Q-BE-4):
  // `Authorization: [^\s]+` stopped at the first space and left the base64
  // credential, which decodes straight back to the PAT. The whole value goes,
  // whatever its scheme and whoever produced it.
  /Authorization:[^\r\n]*/gi,
];

/**
 * A run token shorter than this is not redacted by literal match: a two-letter
 * "token" would blank out unrelated words and make the error message useless.
 * Real PATs are far longer, so nothing legitimate is lost.
 */
const MIN_LITERAL_TOKEN_LENGTH = 8;

function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace every known secret shape in `text` with `***REDACTED***`.
 *
 * @param text      any string about to be logged, thrown or stored
 * @param runToken  the current run's PAT, or any other literal secret derived
 *                  from it (the base64 credential in the `Authorization`
 *                  header, for instance) — call once per secret
 */
export function redact(text: string, runToken?: string): string {
  let out = text;

  if (runToken !== undefined && runToken.length >= MIN_LITERAL_TOKEN_LENGTH) {
    out = out.replace(new RegExp(escapeForRegExp(runToken), "g"), REDACTED);
  }

  for (const pattern of TOKEN_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }

  return out;
}

/** `redact()` over a list of secrets — order does not matter, all are literal. */
export function redactAll(text: string, secrets: (string | undefined)[]): string {
  let out = redact(text, undefined);
  for (const secret of secrets) {
    if (secret === undefined) continue;
    out = redact(out, secret);
  }
  return out;
}
