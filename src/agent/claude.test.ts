/**
 * Tests for the Claude Code client (`src/agent/claude`).
 *
 * The process runner is injected, so these check the CLI contract — the flags
 * that keep the call tool-less, the credential it authenticates with, and the
 * error text an operator reads when a run fails.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { complete, renderPrompt } from './claude.ts';
import type { run } from './git.ts';

const MESSAGES = [
  { role: 'system' as const, content: 'rules' },
  { role: 'user' as const, content: 'hi' },
];

/** A runner that records its call and answers with `output`. */
function fakeRunner(output: string, status = 0) {
  const calls: Array<{ args: string[]; options: Parameters<typeof run>[2] }> = [];
  const runner: typeof run = (_command, args, options) => {
    calls.push({ args, options });
    return { ok: status === 0, status, output };
  };
  return { runner, calls };
}

describe('complete', () => {
  it('runs the CLI tool-less with the subscription token and reads the result', async () => {
    const { runner, calls } = fakeRunner(
      JSON.stringify({
        type: 'result',
        is_error: false,
        result: 'ok',
        usage: { input_tokens: 2, cache_creation_input_tokens: 1, output_tokens: 1 },
      }),
    );

    const result = await complete(MESSAGES, {
      oauthToken: 'sk-ant-oat-test',
      model: 'claude-haiku-5-5',
      maxTokens: 8000,
      runner,
    });

    assert.deepEqual(result, { content: 'ok', promptTokens: 3, completionTokens: 1 });
    const call = calls[0];
    assert.ok(call);
    assert.equal(call.options.input, 'hi');
    assert.equal(call.args[call.args.indexOf('--system-prompt') + 1], 'rules');
    assert.equal(call.args[call.args.indexOf('--tools') + 1], '');
    assert.equal(call.args[call.args.indexOf('--model') + 1], 'claude-haiku-5-5');
    assert.equal(call.options.env?.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat-test');
    assert.equal(call.options.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '8000');
    assert.equal(call.options.env?.GH_TOKEN, undefined);
  });

  it('surfaces the CLI error when the subscription rejects the call', async () => {
    const { runner } = fakeRunner(
      JSON.stringify({ is_error: true, result: 'Invalid API key · Please run /login' }),
      1,
    );
    await assert.rejects(
      complete(MESSAGES, { oauthToken: 'x', model: 'm', runner }),
      /claude exited 1: Invalid API key/,
    );
  });

  it('rejects an empty completion instead of returning a blank diff', async () => {
    const { runner } = fakeRunner(JSON.stringify({ is_error: false, result: '' }));
    await assert.rejects(
      complete(MESSAGES, { oauthToken: 'x', model: 'm', runner }),
      /empty completion/,
    );
  });
});

describe('renderPrompt', () => {
  it('replays a repair round as labelled sections', () => {
    const prompt = renderPrompt([
      { role: 'system', content: 'rules' },
      { role: 'user', content: 'fix it' },
      { role: 'assistant', content: '```diff\n-a\n+b\n```' },
      { role: 'user', content: 'that failed' },
    ]);
    assert.equal(prompt.includes('rules'), false);
    assert.match(prompt, /## Request\n\nfix it\n\n## Your previous answer\n\n```diff/);
    assert.match(prompt, /## Request\n\nthat failed$/);
  });
});
