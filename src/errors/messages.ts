/**
 * The single source of truth for user-facing error text (TASK-001 §7).
 *
 * Every code in SPEC-001 "Error codes" appears here exactly once, in both
 * supported languages. No error text is composed anywhere else in the backend,
 * and the frontend never composes error text from a code (SPEC-001 "API").
 *
 * NOTE for TASK-003: `detail` is raw text coming from `git`. It must be passed
 * through the PAT redactor *before* it reaches this module.
 */

export const ERROR_CODES = [
  "AUTH_REQUIRED",
  "INVALID_CREDENTIALS",
  "VALIDATION_ERROR",
  "REPO_NOT_FOUND",
  "REPO_AUTH_FAILED",
  "BRANCH_NOT_FOUND",
  "CLONE_FAILED",
  "CLONE_TIMEOUT",
  "AI_UNAVAILABLE",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const LANGUAGES = ["th", "en"] as const;
export type Language = (typeof LANGUAGES)[number];

export const DEFAULT_LANGUAGE: Language = "th";

export type MessageParams = {
  /** Branch name, for BRANCH_NOT_FOUND. */
  branch?: string;
  /** Sanitized underlying message, for CLONE_FAILED. */
  detail?: string;
};

type Template = (params: MessageParams) => string;

const MESSAGES: Record<ErrorCode, Record<Language, Template>> = {
  AUTH_REQUIRED: {
    th: () => "เซสชันหมดอายุแล้ว กรุณาเข้าสู่ระบบอีกครั้ง",
    en: () => "Your session has expired. Please log in again.",
  },
  INVALID_CREDENTIALS: {
    th: () => "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง",
    en: () => "Wrong username or password.",
  },
  VALIDATION_ERROR: {
    th: () => "ข้อมูลที่กรอกไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง",
    en: () => "Some of the information you entered is not valid.",
  },
  REPO_NOT_FOUND: {
    th: () => "ไม่พบที่อยู่ของ repository นี้",
    en: () => "Repository address not found.",
  },
  REPO_AUTH_FAILED: {
    th: () =>
      "repository นี้ต้องใช้ access token ที่ถูกต้อง " +
      "อาจเป็น repository ส่วนตัว หรืออาจไม่มีอยู่จริง",
    en: () =>
      "This repository needs a valid access token — it may be private, " +
      "or it may not exist.",
  },
  BRANCH_NOT_FOUND: {
    th: ({ branch }) =>
      branch === undefined
        ? "ไม่พบ branch ที่ระบุใน repository นี้"
        : `ไม่พบ branch "${branch}" ใน repository นี้`,
    en: ({ branch }) =>
      branch === undefined
        ? "The branch you asked for does not exist in this repository."
        : `Branch "${branch}" does not exist in this repository.`,
  },
  CLONE_FAILED: {
    th: ({ detail }) =>
      detail === undefined
        ? "ไม่สามารถดึงข้อมูลจาก repository นี้ได้"
        : `ไม่สามารถดึงข้อมูลจาก repository นี้ได้: ${detail}`,
    en: ({ detail }) =>
      detail === undefined
        ? "Could not read this repository."
        : `Could not read this repository: ${detail}`,
  },
  CLONE_TIMEOUT: {
    th: () =>
      "repository นี้ใหญ่หรือช้าเกินไป จึงดึงข้อมูลไม่สำเร็จภายในเวลาที่กำหนด",
    en: () =>
      "This repository is too large or too slow — reading it timed out.",
  },
  AI_UNAVAILABLE: {
    th: () => "ระบบวิเคราะห์ไม่พร้อมใช้งานขณะนี้ กรุณาลองใหม่อีกครั้ง",
    en: () => "The analysis service is unavailable right now. Please try again.",
  },
  INTERNAL: {
    th: () => "เกิดข้อผิดพลาดภายในระบบ",
    en: () => "Something went wrong.",
  },
};

export function isLanguage(value: string): value is Language {
  return (LANGUAGES as readonly string[]).includes(value);
}

/**
 * Resolve the message language from an `Accept-Language` header.
 * Anything we do not speak falls back to the default (`th`, SPEC-001 "API").
 */
export function languageFromAcceptHeader(header: string | undefined): Language {
  if (header === undefined) return DEFAULT_LANGUAGE;
  for (const part of header.split(",")) {
    const tag = part.split(";")[0]?.trim().toLowerCase() ?? "";
    const primary = tag.split("-")[0] ?? "";
    if (isLanguage(primary)) return primary;
  }
  return DEFAULT_LANGUAGE;
}

export function errorMessage(
  code: ErrorCode,
  language: Language = DEFAULT_LANGUAGE,
  params: MessageParams = {},
): string {
  return MESSAGES[code][language](params);
}

/* ------------------------------------------------------------------ *
 * Per-field validation text (TASK-005 §1)
 *
 * `VALIDATION_ERROR` carries a `fields` map whose values the frontend shows
 * verbatim, so they are user-facing copy and they live here — the single
 * source of truth this module already is — rather than inline in the
 * validator. One line per string, both languages, so a reword is a copy edit.
 * ------------------------------------------------------------------ */

export const VALIDATION_ISSUES = [
  "REQUIRED",
  "INVALID_TYPE",
  "INVALID_URL",
  "INVALID_DATE",
  "DATE_ORDER",
  "SPAN_TOO_LONG",
  "INVALID_LANGUAGE",
  "TOO_LONG",
] as const;

export type ValidationIssue = (typeof VALIDATION_ISSUES)[number];

/** `limit` is used by SPAN_TOO_LONG and TOO_LONG; ignored by the rest. */
export type FieldMessageParams = { limit?: number };

const FIELD_MESSAGES: Record<
  ValidationIssue,
  Record<Language, (params: FieldMessageParams) => string>
> = {
  REQUIRED: {
    th: () => "จำเป็นต้องกรอกข้อมูลนี้",
    en: () => "This field is required.",
  },
  INVALID_TYPE: {
    th: () => "รูปแบบข้อมูลไม่ถูกต้อง",
    en: () => "This value has the wrong type.",
  },
  INVALID_URL: {
    th: () => "ต้องเป็นที่อยู่ http หรือ https ที่ถูกต้อง",
    en: () => "Must be a valid http or https address.",
  },
  INVALID_DATE: {
    th: () => "ต้องเป็นวันที่ในรูปแบบ YYYY-MM-DD",
    en: () => "Must be a date in YYYY-MM-DD format.",
  },
  DATE_ORDER: {
    th: () => "ต้องไม่อยู่ก่อนวันเริ่มต้น",
    en: () => "Must not be before dateFrom.",
  },
  SPAN_TOO_LONG: {
    th: ({ limit }) => `ช่วงวันที่ต้องไม่เกิน ${limit ?? 366} วัน`,
    en: ({ limit }) =>
      `The period must not be longer than ${limit ?? 366} days.`,
  },
  INVALID_LANGUAGE: {
    th: () => 'ต้องเป็น "th" หรือ "en"',
    en: () => 'Must be either "th" or "en".',
  },
  TOO_LONG: {
    th: ({ limit }) => `ยาวเกินกำหนด (สูงสุด ${limit ?? 0} ตัวอักษร)`,
    en: ({ limit }) => `Too long (maximum ${limit ?? 0} characters).`,
  },
};

export function fieldMessage(
  issue: ValidationIssue,
  language: Language = DEFAULT_LANGUAGE,
  params: FieldMessageParams = {},
): string {
  return FIELD_MESSAGES[issue][language](params);
}
