/**
 * Environment configuration (TASK-001 §2).
 *
 * Parsed and validated once at startup. Missing required variables are a
 * fatal, loud failure — not a default that silently misbehaves later.
 *
 * SECRETS: the values of SESSION_SECRET and AI_API_CENTER_TOKEN must never be
 * logged. `describeConfig()` below is the only sanctioned way to print config.
 */

/** The five internal AI pipeline stages that carry a per-stage model + budget. */
export const AI_STAGE_KEYS = [
  "AI_PROJECT",
  "AI_COMMITS",
  "AI_CURIOUSNESS",
  "AI_UNDERSTANDING",
  "AI_WRITING",
] as const;
export type AiStageKey = (typeof AI_STAGE_KEYS)[number];

/** Per-call settings the pipeline threads into every AI API CENTER request. */
export type StageModelConfig = { model: string; maxTokens: number };
export type AiStagesConfig = Record<AiStageKey, StageModelConfig>;

/**
 * Approved model ids → their per-call `max_tokens` cap (SPEC-007 §Configuration,
 * TASK-025). A stage's `max_tokens` may not exceed the cap of the model it is
 * assigned; an unknown model id for any stage is a fatal config error.
 */
export const APPROVED_MODEL_CAPS: Record<string, number> = {
  "gpt-4.1": 50000,
  "grok-4-latest": 50000,
  "gpt-4.1-mini": 30000,
  "deepseek-v4-pro": 30000,
};

/**
 * Model → stage defaults (SPEC-007 D3). PENDING stakeholder confirmation via
 * Q-REQ008-1: these are defaults only and every one is env-overridable, so the
 * stakeholder can change any of them without a code change. All are within the
 * approved per-call caps above.
 */
const STAGE_MODEL_DEFAULTS: Record<AiStageKey, string> = {
  AI_PROJECT: "gpt-4.1-mini",
  AI_COMMITS: "gpt-4.1-mini",
  AI_CURIOUSNESS: "grok-4-latest",
  AI_UNDERSTANDING: "gpt-4.1",
  AI_WRITING: "gpt-4.1",
};

/** max_tokens defaults per stage (SPEC-007 §Configuration table). */
const STAGE_MAX_TOKENS_DEFAULTS: Record<AiStageKey, number> = {
  AI_PROJECT: 20000,
  AI_COMMITS: 20000,
  AI_CURIOUSNESS: 50000,
  AI_UNDERSTANDING: 40000,
  AI_WRITING: 50000,
};

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
  /** Per-stage model + max_tokens the pipeline sends on every AI call. */
  aiStages: AiStagesConfig;
  /** AI_CURIOUSNESS investigation loop cap (SPEC-007 §Flow 3). */
  aiCuriosityMaxIterations: number;
  /** AI_WRITING by-topic pass cap (SPEC-007 §Flow 5). */
  aiWritingMaxPasses: number;
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

/**
 * Load, default and validate the per-stage model + max_tokens settings. An
 * unknown model id, or a `max_tokens` above the assigned model's cap, is a fatal
 * `ConfigError` at startup so a misconfiguration can never reach the wire
 * (SPEC-007 §Configuration "Cap enforcement", TASK-025 AC 8).
 */
function loadAiStages(env: Env): AiStagesConfig {
  const stages = {} as AiStagesConfig;
  for (const stage of AI_STAGE_KEYS) {
    const model = optionalWithDefault(
      env,
      `${stage}_MODEL`,
      STAGE_MODEL_DEFAULTS[stage],
    );
    const cap = APPROVED_MODEL_CAPS[model];
    if (cap === undefined) {
      throw new ConfigError(
        `Environment variable ${stage}_MODEL is "${model}", which is not an ` +
          `approved model id. Approved: ${Object.keys(APPROVED_MODEL_CAPS).join(", ")}.`,
      );
    }
    const maxTokens = positiveInt(
      env,
      `${stage}_MAX_TOKENS`,
      STAGE_MAX_TOKENS_DEFAULTS[stage],
    );
    if (maxTokens > cap) {
      throw new ConfigError(
        `Environment variable ${stage}_MAX_TOKENS is ${maxTokens}, which exceeds ` +
          `the ${cap} per-call cap of model "${model}".`,
      );
    }
    stages[stage] = { model, maxTokens };
  }
  return stages;
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
    aiStages: loadAiStages(env),
    aiCuriosityMaxIterations: positiveInt(env, "AI_CURIOUSNESS_MAX_ITERATIONS", 5),
    aiWritingMaxPasses: positiveInt(env, "AI_WRITING_MAX_PASSES", 3),
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
    aiStages: config.aiStages,
    aiCuriosityMaxIterations: config.aiCuriosityMaxIterations,
    aiWritingMaxPasses: config.aiWritingMaxPasses,
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
