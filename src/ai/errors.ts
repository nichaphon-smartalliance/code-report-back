/**
 * The one error type the AI layer throws (TASK-004).
 *
 * Mirrors `src/git/errors.ts` on purpose: it carries a SPEC-001 error code so
 * the worker (TASK-005) can store it verbatim, and an already-redacted
 * `detail`. No user-facing text is composed here — that lives in
 * `src/errors/messages.ts`.
 */

import type { ErrorCode } from "../errors/messages.ts";
import { redact } from "../git/redact.ts";

export class AiLayerError extends Error {
  readonly code: ErrorCode;
  /** Why the call failed, in developer English. Redacted at construction. */
  readonly detail: string | undefined;

  constructor(code: ErrorCode, options: { detail?: string | undefined } = {}) {
    const detail =
      options.detail === undefined ? undefined : redact(options.detail);
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = "AiLayerError";
    this.code = code;
    this.detail = detail;
  }
}
