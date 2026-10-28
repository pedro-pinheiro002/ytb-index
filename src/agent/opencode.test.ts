/**
 * Tests for the OpenCode Go client (`src/agent/opencode`).
 *
 * The transport is injected, so these check the request contract the service
 * enforces — the headers it routes on and the error text an operator reads when
 * a run fails.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { complete } from './opencode.ts';

const MESSAGES = [{ role: 'user' as const, content: 'hi' }];

describe('complete', () => {
  it('sends the session header OpenCode Go requires for routing', async () => {
    let seen: RequestInit | undefined;
    const result = await complete(MESSAGES, {
      baseUrl: 'https://example.test/v1',
      apiKey: 'key',
      model: 'model',
      session: 'agent-SMOKE-1',
      transport: async (_url, init) => {
        seen = init;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: 'ok' } }],
            usage: { prompt_tokens: 3, completion_tokens: 1 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });

    const headers = seen?.headers as Record<string, string>;
    assert.equal(headers['x-opencode-session'], 'agent-SMOKE-1');
    assert.equal(headers.authorization, 'Bearer key');
    assert.deepEqual(result, { content: 'ok', promptTokens: 3, completionTokens: 1 });
  });

  it('surfaces the response body when the service rejects the request', async () => {
    await assert.rejects(
      complete(MESSAGES, {
        baseUrl: 'https://example.test/v1',
        apiKey: 'key',
        model: 'model',
        session: 'agent-X',
        transport: async () =>
          new Response(JSON.stringify({ error: { type: 'MissingSessionID' } }), { status: 400 }),
      }),
      /opencode 400: .*MissingSessionID/,
    );
  });

  it('rejects an empty completion instead of returning a blank diff', async () => {
    await assert.rejects(
      complete(MESSAGES, {
        baseUrl: 'https://example.test/v1',
        apiKey: 'key',
        model: 'model',
        session: 'agent-X',
        transport: async () => new Response(JSON.stringify({ choices: [] }), { status: 200 }),
      }),
      /empty completion/,
    );
  });
});
