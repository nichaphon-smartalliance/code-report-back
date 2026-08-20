/**
 * Environment configuration (TASK-001 §2).
 *
 * Parsed and validated once at startup. Missing required variables are a
 * fatal, loud failure — not a default that silently misbehaves later.
 *
 * SECRETS: the values of SESSION_SECRET and AI_API_CENTER_TOKEN must never be
 * logged. `describeConfig()` below is the only sanctioned way to print config.
 */

export type Config = {
  DATABASE_URL: string;
  SESSION_SECRET: string;
  PORT: number;
  REPORT_TIMEZONE: string;
  AI_API_CENTER_URL: string;
  AI_API_CENTER_TOKEN: string | undefined;
  ALLOW_PRIVATE_GIT_HOSTS: boolean;
  MAX_CONCURRENT_JOBS: number;
  SEED_USERS_FILE: string | undefined;
};

export type Env = Record<string, string | undefined>;

/** Thrown when the environment is not usable. Message is safe to print. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function required(env: Env, name: string): string {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    throw new ConfigError(
      `Missing required environment variable ${name}. See .env.example.`,
    );
  }
  return raw;
}

function optional(env: Env, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  return raw;
}

function optionalWithDefault(env: Env, name: string, fallback: string): string {
  return optional(env, name) ?? fallback;
}

function positiveInt(env: Env, name: string, fallback: number): number {
  const raw = optional(env, name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(
      `Environment variable ${name} must be a positive integer, got "${raw}".`,
    );
  }
  return parsed;
}

function boolean(env: Env, name: string, fallback: boolean): boolean {
  const raw = optional(env, name);
  if (raw === undefined) return fallback;
  const normalised = raw.trim().toLowerCase();
  if (normalised === "true") return true;
  if (normalised === "false") return false;
  throw new ConfigError(
    `Environment variable ${name} must be "true" or "false", got "${raw}".`,
  );
}

export function loadConfig(env: Env): Config {
  return {
    DATABASE_URL: required(env, "DATABASE_URL"),
    SESSION_SECRET: required(env, "SESSION_SECRET"),
    PORT: positiveInt(env, "PORT", 8080),
    REPORT_TIMEZONE: optionalWithDefault(env, "REPORT_TIMEZONE", "Asia/Bangkok"),
    AI_API_CENTER_URL: optionalWithDefault(
      env,
      "AI_API_CENTER_URL",
      "http://localhost:3009",
    ),
    AI_API_CENTER_TOKEN: optional(env, "AI_API_CENTER_TOKEN"),
    ALLOW_PRIVATE_GIT_HOSTS: boolean(env, "ALLOW_PRIVATE_GIT_HOSTS", false),
    MAX_CONCURRENT_JOBS: positiveInt(env, "MAX_CONCURRENT_JOBS", 2),
    SEED_USERS_FILE: optional(env, "SEED_USERS_FILE"),
  };
}

/**
 * A log-safe view of the config: secrets are reduced to a presence flag and
 * DATABASE_URL to host/database, so nothing sensitive can reach a log sink.
 */
export function describeConfig(config: Config): Record<string, unknown> {
  let database = "<unparseable>";
  try {
    const url = new URL(config.DATABASE_URL);
    database = `${url.host}${url.pathname}`;
  } catch {
    /* keep the placeholder — never echo the raw URL, it carries a password */
  }
  return {
    database,
    port: config.PORT,
    reportTimezone: config.REPORT_TIMEZONE,
    aiApiCenterUrl: config.AI_API_CENTER_URL,
    aiApiCenterTokenSet: config.AI_API_CENTER_TOKEN !== undefined,
    sessionSecretSet: config.SESSION_SECRET.length > 0,
    allowPrivateGitHosts: config.ALLOW_PRIVATE_GIT_HOSTS,
    maxConcurrentJobs: config.MAX_CONCURRENT_JOBS,
    seedUsersFileSet: config.SEED_USERS_FILE !== undefined,
  };
}

/**
 * Entry-point helper: load the config or exit non-zero with a clear message.
 * Used by the server, the migration runner and the seed script.
 */
export function loadConfigOrExit(env: Env = process.env): Config {
  try {
    return loadConfig(env);
  } catch (error) {
    const message =
      error instanceof ConfigError ? error.message : String(error);
    console.error(`[config] ${message}`);
    process.exit(1);
  }
}
