/**
 * The one error type this module throws (TASK-003).
 *
 * It carries a SPEC-001 error code so the worker (TASK-005) can store it
 * verbatim, and an already-redacted `detail` for `CLONE_FAILED`. Nothing here
 * composes user-facing text — that lives in `src/errors/messages.ts`.
 */

import type { ErrorCode } from "../errors/messages.ts";

export class GitLayerError extends Error {
  readonly code: ErrorCode;
  /** Sanitized git output, only set for CLONE_FAILED. Already redacted. */
  readonly detail: string | undefined;
  /** The branch the user asked for, only set for BRANCH_NOT_FOUND. */
  readonly branch: string | undefined;

  constructor(
    code: ErrorCode,
    options: { detail?: string | undefined; branch?: string | undefined } = {},
  ) {
    // The message is for developers reading a stack trace; the detail is
    // already redacted by the caller, so this line is safe to print.
    super(
      options.detail === undefined ? code : `${code}: ${options.detail}`,
    );
    this.name = "GitLayerError";
    this.code = code;
    this.detail = options.detail;
    this.branch = options.branch;
  }
}
