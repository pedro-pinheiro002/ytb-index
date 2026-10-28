/**
 * OpenCode Go client (`src/agent/opencode`).
 *
 * OpenAI-compatible chat completions at
 * `https://opencode.ai/inference/go/openai/v1/chat/completions`. The request is
 * deliberately boring: low temperature, bounded output, no tools, no
 * streaming. The agent applies the model's diff locally and verifies it, so
 * the transport only has to be reliable and to fail with a readable error.
 */
import type { ChatMessage } from './prompt.ts';

/** Settings the client needs from `AgentConfig`. */
export interface OpenCodeOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Hard cap on output tokens; a diff is small. */
  maxTokens?: number;
  /** Injectable transport for tests; defaults to `globalThis.fetch`. */
  transport?: (url: string, init: RequestInit) => Promise<Response>;
  /** Override the request timeout (ms). */
  timeoutMs?: number;
}

/** One completion's text and the usage counters (for the run log). */
export interface OpenCodeResult {
  content: string;
  promptTokens: number;
  completionTokens: number;
}

/** Shape of the subset of the response body we read. */
interface ChatCompletion {
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
}

/** POST the messages and return the assistant text. */
export async function complete(
  messages: ChatMessage[],
  options: OpenCodeOptions,
): Promise<OpenCodeResult> {
  const transport = options.transport ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 120_000;

  const response = await transport(`${options.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${options.apiKey}`,
      'content-type': 'application/json',
      'user-agent': 'ytb-index-agent',
    },
    body: JSON.stringify({
      model: options.model,
      messages,
      temperature: 0.2,
      max_tokens: options.maxTokens ?? 2500,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`opencode ${response.status}: ${body.slice(0, 500)}`);
  }

  const parsed = (await response.json()) as ChatCompletion;
  const content = parsed.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error('opencode returned an empty completion');
  }

  return {
    content,
    promptTokens: typeof parsed.usage?.prompt_tokens === 'number' ? parsed.usage.prompt_tokens : 0,
    completionTokens:
      typeof parsed.usage?.completion_tokens === 'number' ? parsed.usage.completion_tokens : 0,
  };
}
