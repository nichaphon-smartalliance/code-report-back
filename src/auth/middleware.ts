/**
 * `requireSession` (TASK-002 §5).
 *
 * Applied to every `/api/reports*` route. A missing, expired or tampered cookie
 * is answered with `401 AUTH_REQUIRED` and the handler behind it never runs —
 * REQ-001's acceptance criterion is that a logged-out visitor cannot *start*
 * work, not merely that they cannot see the result.
 */

import type { MiddlewareHandler } from "hono";
import { errorEnvelope, requestLanguage } from "../errors/index.ts";
import { sessionUserId } from "./session.ts";

export type SessionEnv = {
  Variables: {
    /** Set by `requireSession`; present only inside a protected handler. */
    userId: string;
  };
};

export const requireSession: MiddlewareHandler<SessionEnv> = async (c, next) => {
  const userId = await sessionUserId(c);
  if (userId === undefined) {
    return c.json(errorEnvelope("AUTH_REQUIRED", requestLanguage(c)), 401);
  }
  c.set("userId", userId);
  await next();
};
