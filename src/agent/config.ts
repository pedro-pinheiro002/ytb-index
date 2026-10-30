/**
 * Environment and payload loading for the repair agent (`src/agent/config`).
 *
 * The agent runs inside a GitHub Actions job, never in the Worker or the Node
 * server: this module is the only place that reads `process.env`, so every
 * other agent module stays pure and injectable for tests. Missing
 * configuration fails loudly *before* the model is called, which keeps a
 * misconfigured run from spending quota.
 */

/** The issue coordinates the workflow receives from `repository_dispatch`. */
export interface AgentPayload {
  /** Sentry issue id. */
  issueId: string;
  /** Issue title, e.g. `TypeError: x is not a function`. */
  title: string;
  /** `error` | `fatal`. */
  level: string;
  /** Sentry short id, used in branch names. */
  shortId: string;
  /** Sentry grouping fingerprint. */
  fingerprint: string;
  /** Sentry permalink. */
  permalink: string;
}

/** All agent settings, validated. */
export interface AgentConfig {
  /** Sentry auth token (`event:read`, `project:read`). */
  sentryToken: string;
  /** Sentry origin, no trailing slash. */
  sentryUrl: string;
  /** Claude Code OAuth token (`claude setup-token`, Pro/Max subscription). */
  claudeOauthToken: string;
  /** Model id or alias passed to `claude --model`. */
  model: string;
  /** GitHub token used by `git push` and `gh`. */
  ghToken: string;
  /** Telegram bot token, optional: notifications degrade to logs. */
  telegramBotToken: string | undefined;
  /** Telegram chat id, optional. */
  telegramChatId: string | undefined;
  /** Hard cap on a proposed diff's changed lines. */
  maxDiffLines: number;
  /** Model attempts (first proposal + repairs). */
  maxAttempts: number;
  /** Output budget per attempt; reasoning tokens count against it. */
  maxTokens: number;
  /** Repository root (`GITHUB_WORKSPACE`). */
  repoRoot: string;
}

/** Thrown when required configuration is absent; message lists every gap. */
export class AgentConfigError extends Error {
  constructor(missing: string[]) {
    super(`missing configuration: ${missing.join(', ')}`);
    this.name = 'AgentConfigError';
  }
}

/** Read a required variable or record it as missing. */
function required(env: NodeJS.ProcessEnv, name: string, missing: string[]): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    missing.push(name);
    return '';
  }
  return value.trim();
}

/**
 * Trim a raw value, mapping blank to `undefined`.
 *
 * Actions substitutes an unset secret with `''`, not with an absent variable,
 * so `''` must mean "not configured" here — otherwise a Telegram call would be
 * attempted against an empty bot token.
 */
export function optionalValue(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

/** Read an optional variable as `string | undefined` (never `''`). */
function optional(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return optionalValue(env[name]);
}

/** Read a positive integer with a default; reject `NaN`/`0`/negatives. */
function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = optional(env, name);
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Load and validate every setting the agent needs. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const missing: string[] = [];
  const config: AgentConfig = {
    sentryToken: required(env, 'SENTRY_AUTH_TOKEN', missing),
    sentryUrl: (optional(env, 'SENTRY_URL') ?? 'https://sentry.io').replace(/\/+$/, ''),
    claudeOauthToken: required(env, 'CLAUDE_CODE_OAUTH_TOKEN', missing),
    model: optional(env, 'AGENT_MODEL') ?? 'claude-haiku-5-5',
    ghToken: required(env, 'GH_TOKEN', missing),
    telegramBotToken: optional(env, 'TELEGRAM_BOT_TOKEN'),
    telegramChatId: optional(env, 'TELEGRAM_CHAT_ID'),
    maxDiffLines: positiveInt(env, 'AGENT_MAX_DIFF_LINES', 200),
    maxAttempts: positiveInt(env, 'AGENT_MAX_ATTEMPTS', 2),
    maxTokens: positiveInt(env, 'AGENT_MAX_TOKENS', 8000),
    repoRoot: optional(env, 'GITHUB_WORKSPACE') ?? process.cwd(),
  };

  if (missing.length > 0) {
    throw new AgentConfigError(missing);
  }
  return config;
}

/** Parse the `client_payload` the Worker forwarded through the dispatch. */
export function loadPayload(raw: string | undefined): AgentPayload {
  if (raw === undefined || raw.trim() === '') {
    throw new AgentConfigError(['AGENT_PAYLOAD']);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('AGENT_PAYLOAD is not valid JSON');
  }

  // The workflow passes `toJSON(github.event.client_payload)`, which is
  // `{ issue: {...} }`; accept a bare issue object too so the script can be
  // replayed by hand from a terminal.
  const candidate =
    typeof parsed === 'object' && parsed !== null && 'issue' in parsed
      ? (parsed as { issue?: unknown }).issue
      : parsed;

  if (typeof candidate !== 'object' || candidate === null) {
    throw new Error('AGENT_PAYLOAD has no issue object');
  }

  const issue = candidate as Record<string, unknown>;
  const issueId = typeof issue.issueId === 'string' ? issue.issueId : '';
  if (issueId === '') {
    throw new Error('AGENT_PAYLOAD.issue.issueId is required');
  }

  return {
    issueId,
    title: typeof issue.title === 'string' ? issue.title : '(untitled issue)',
    level: typeof issue.level === 'string' ? issue.level : 'error',
    shortId: typeof issue.shortId === 'string' ? issue.shortId : issueId,
    fingerprint: typeof issue.fingerprint === 'string' ? issue.fingerprint : issueId,
    permalink: typeof issue.permalink === 'string' ? issue.permalink : '',
  };
}
