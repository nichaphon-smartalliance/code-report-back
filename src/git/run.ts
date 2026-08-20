/**
 * The only place this backend starts a `git` process (TASK-003).
 *
 * Two rules, both from SPEC-001 "Non-functional → Repo URL safety":
 *   - `git` is spawned with an **argv array**, never through a shell, so a
 *     repository URL can never become a command;
 *   - the child gets `GIT_TERMINAL_PROMPT=0` and `GIT_ASKPASS=/bin/false`, so a
 *     private repository fails fast instead of hanging on a credential prompt.
 *
 * stdin is closed for the same reason.
 */

import { redactAll } from "./redact.ts";

export type GitRun = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type GitRunOptions = {
  cwd?: string | undefined;
  /** Wall-clock budget; the process is killed when it is exceeded. */
  timeoutMs?: number;
  /** Literal secrets to redact out of stdout/stderr before anyone sees them. */
  secrets?: (string | undefined)[];
};

/** The environment every `git` child runs with. */
export const GIT_CHILD_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "/bin/false",
  // A stray credential helper on the operator's machine must not silently
  // supply credentials for a repository the user did not authorise.
  GIT_CONFIG_NOSYSTEM: "1",
};

export type GitRunner = (
  args: string[],
  options?: GitRunOptions,
) => Promise<GitRun>;

export const runGit: GitRunner = async (args, options = {}) => {
  const child = Bun.spawn(["git", ...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: { ...process.env, ...GIT_CHILD_ENV },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (options.timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);
  }

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const secrets = options.secrets ?? [];
    return {
      exitCode,
      stdout: redactAll(stdout, secrets),
      stderr: redactAll(stderr, secrets),
      timedOut,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/** First non-empty line of git's stderr — what a human actually needs to read. */
export function firstMeaningfulLine(stderr: string): string | undefined {
  for (const line of stderr.split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "") return trimmed;
  }
  return undefined;
}
