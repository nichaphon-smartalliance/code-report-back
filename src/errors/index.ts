/**
 * The error envelope (TASK-001 §7, SPEC-001 "API / Interface Design").
 *
 * Every error response in this backend has the shape
 * `{ "error": { "code": "<CODE>", "message": "<human readable>" } }`
 * and `message` is already in the language the client asked for.
 */

import type { Context } from "hono";
import {
  DEFAULT_LANGUAGE,
  errorMessage,
  languageFromAcceptHeader,
  type ErrorCode,
  type Language,
  type MessageParams,
} from "./messages.ts";

export type ErrorEnvelope = {
  error: { code: ErrorCode; message: string };
};

export function errorEnvelope(
  code: ErrorCode,
  language: Language = DEFAULT_LANGUAGE,
  params: MessageParams = {},
): ErrorEnvelope {
  return { error: { code, message: errorMessage(code, language, params) } };
}

/** The language this request wants its error messages in. */
export function requestLanguage(c: Context): Language {
  return languageFromAcceptHeader(c.req.header("Accept-Language"));
}

export * from "./messages.ts";
