/**
 * The "no work in this period" note (TASK-004 §4).
 *
 * A backend template, **no AI call** — SPEC-001 makes `NO_COMMITS` a success
 * status, not an error, and there is nothing for a model to analyse.
 *
 * The wording is Sober's stated default for the still-open Q-SA-4 (the final
 * user-facing copy is the stakeholder's). It lives here, in one place and
 * nowhere else, so that answering Q-SA-4 is a one-line edit.
 */

import type { Language } from "../errors/messages.ts";

export type NoCommitsInput = {
  repoUrl: string;
  branch?: string | undefined;
  author?: string | undefined;
  /** `YYYY-MM-DD`, the wire format. */
  dateFrom: string;
  dateTo: string;
  language: Language;
};

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * `2026-08-07` → `07/Aug/26` — REQ-001 Requirement 15, the one stated rule for
 * a date this tool shows a human, English month abbreviation in **both** UI
 * languages, Gregorian two-digit year, no Buddhist era. The frontend's
 * `format.ts` renders every other visible date the same way; this note is
 * markdown produced by the backend, so it has to do it itself.
 */
export function formatDisplayDate(isoDate: string): string {
  const parts = isoDate.split("-");
  const [year = "", month = "", day = ""] = parts;
  const monthName = MONTHS[Number(month) - 1];
  if (parts.length !== 3 || monthName === undefined) return isoDate;
  return `${day}/${monthName}/${year.slice(-2)}`;
}

export function noCommitsReport(input: NoCommitsInput): string {
  const from = formatDisplayDate(input.dateFrom);
  const to = formatDisplayDate(input.dateTo);
  const branch = input.branch;
  const author = input.author;

  if (input.language === "th") {
    const extra =
      (branch === undefined ? "" : `, branch ${branch}`) +
      (author === undefined ? "" : `, ผู้พัฒนา ${author}`);
    return [
      "# รายงานการพัฒนา",
      "",
      `ไม่พบการทำงานในช่วงวันที่ที่เลือก (${from} – ${to}) สำหรับ ${input.repoUrl}${extra}`,
      "",
    ].join("\n");
  }

  const extra =
    (branch === undefined ? "" : `, branch ${branch}`) +
    (author === undefined ? "" : `, author ${author}`);
  return [
    "# Dev work report",
    "",
    `No commits were found for the selected period (${from} – ${to}) in ${input.repoUrl}${extra}.`,
    "",
  ].join("\n");
}
