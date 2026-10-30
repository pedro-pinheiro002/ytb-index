/**
 * Claude Code client (`src/agent/claude`), ADR-0006 (amended: model provider).
 *
 * Runs the Claude Code CLI headless (`claude -p --output-format json`) so the
 * agent can use a Claude Pro/Max subscription through `CLAUDE_CODE_OAUTH_TOKEN`
 * (from `claude setup-token`); a subscription carries no API key. The call is
 * deliberately boring: no tools, one turn, no project settings, run outside
 * the checkout. The agent applies the model's diff locally and verifies it, so
 * the transport only has to be reliable and to fail with a readable error.
 */
import { tmpdir } from 'node:os';
import { run, type CommandResult } from './git.ts';
import type { ChatMessage } from './prompt.ts';

/** Settings the client needs from `AgentConfig`. */
export interface ClaudeOptions {
  /** OAuth token from `claude setup-token` (Pro/Max subscription). */
  oauthToken: string;
  /** Model id or alias passed to `--model`. */
  model: string;
  /** Hard cap on output tokens; a diff is small. */
  maxTokens?: number;
  /** Override the call timeout (ms). */
  timeoutMs?: number;
  /** Injectable process runner for tests; defaults to `run` from `./git.ts`. */
  runner?: typeof run;
}

/** One completion's text and the usage counters (for the run log). */
export interface CompletionResult {
  content: string;
  promptTokens: number;
  completionTokens: number;
}

/** Shape of the subset of the CLI's JSON result we read. */
interface CliResult {
  is_error?: unknown;
  subtype?: unknown;
  result?: unknown;
  usage?: {
    input_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
    cache_read_input_tokens?: unknown;
    output_tokens?: unknown;
  };
}

/** Sum the numeric counters, ignoring absent ones. */
function tokens(...values: unknown[]): number {
  return values.reduce<number>((sum, value) => sum + (typeof value === 'number' ? value : 0), 0);
}

/**
 * Render the non-system messages as one prompt.
 *
 * `claude -p` takes a single user turn, so a repair round's earlier answer and
 * the verifier feedback are replayed as labelled sections.
 */
export function renderPrompt(messages: ChatMessage[]): string {
  const turns = messages.filter((message) => message.role !== 'system');
  if (turns.length === 1 && turns[0]?.role === 'user') {
    return turns[0].content;
  }
  return turns
    .map((message) =>
      message.role === 'assistant'
        ? `## Your previous answer\n\n${message.content}`
        : `## Request\n\n${message.content}`,
    )
    .join('\n\n');
}

/** Send the messages to Claude and return the assistant text. */
export async function complete(
  messages: ChatMessage[],
  options: ClaudeOptions,
): Promise<CompletionResult> {
  const runner = options.runner ?? run;
  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');

  const result: CommandResult = runner(
    'claude',
    [
      '-p',
      '--output-format',
      'json',
      '--model',
      options.model,
      '--system-prompt',
      system,
      '--tools',
      '',
      '--setting-sources',
      '',
      '--strict-mcp-config',
      '--no-session-persistence',
    ],
    {
      // Outside the checkout, so no CLAUDE.md or project settings are loaded:
      // the repository rules already arrive through the system prompt.
      cwd: tmpdir(),
      input: renderPrompt(messages),
      timeoutMs: options.timeoutMs ?? 300_000,
      // Only what the CLI needs: the Sentry and GitHub tokens stay out of the
      // model's process.
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        CLAUDE_CODE_OAUTH_TOKEN: options.oauthToken,
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(options.maxTokens ?? 2500),
        DISABLE_AUTOUPDATER: '1',
      },
    },
  );

  // `run` merges stdout and stderr; the JSON result is the last `{` line.
  const line = result.output
    .split('\n')
    .reverse()
    .find((candidate) => candidate.startsWith('{'));
  let parsed: CliResult | undefined;
  try {
    parsed = line === undefined ? undefined : (JSON.parse(line) as CliResult);
  } catch {
    parsed = undefined;
  }

  if (parsed === undefined || !result.ok || parsed.is_error === true) {
    // An expired token, an exhausted subscription limit, or a missing CLI
    // all land here; the CLI's own text is what the operator needs.
    const detail = typeof parsed?.result === 'string' ? parsed.result : result.output;
    throw new Error(`claude exited ${result.status}: ${detail.slice(0, 500)}`);
  }

  const content = parsed.result;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error(
      `claude returned an empty completion (subtype=${String(parsed.subtype)}, ` +
        `output_tokens=${String(parsed.usage?.output_tokens)})`,
    );
  }

  return {
    content,
    promptTokens: tokens(
      parsed.usage?.input_tokens,
      parsed.usage?.cache_creation_input_tokens,
      parsed.usage?.cache_read_input_tokens,
    ),
    completionTokens: tokens(parsed.usage?.output_tokens),
  };
}
