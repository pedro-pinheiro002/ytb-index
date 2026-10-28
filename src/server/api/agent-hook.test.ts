/**
 * Tests for the Sentry webhook receiver (`server/api/agent-hook`).
 *
 * The route is mounted on a bare Hono app (no DB needed): every case drives
 * the real handler through `app.request()`, so signature verification, the
 * action/level filters, the per-isolate debounce, and the
 * `repository_dispatch` call all run without touching the network.
 *
 * Run via `pnpm test` (node:test runner).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { agentHookRoute, type AgentHookConfig } from './agent-hook.ts';
import type { AgentDispatchTransport } from './github-agent-dispatch.ts';

const HOOK_SECRET = 'test-hook-secret';
const DISPATCH_PAT = 'ghp_test_pat';
const GH_OWNER = 'test-owner';
const GH_REPO = 'test-repo';

interface DispatchCall {
  url: string;
  init: RequestInit;
}

/** Build a route harness with an optional transport double. */
function harness(config: Partial<AgentHookConfig> = {}): {
  app: Hono;
  calls: DispatchCall[];
} {
  const calls: DispatchCall[] = [];
  const transport: AgentDispatchTransport = async (url, init) => {
    calls.push({ url, init });
    return new Response(null, { status: 204 });
  };
  const app = new Hono();
  agentHookRoute(app, {
    hookSecret: HOOK_SECRET,
    dispatchPat: DISPATCH_PAT,
    ghOwner: GH_OWNER,
    ghRepo: GH_REPO,
    transport,
    ...config,
  });
  return { app, calls };
}

/** Sign a raw body exactly like Sentry does (HMAC-SHA256 hex). */
function sign(body: string, secret = HOOK_SECRET): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

/** A minimal but realistic Sentry `issue` webhook payload. */
function issueBody(
  overrides: { action?: string; level?: string; status?: string; id?: string } = {},
): string {
  return JSON.stringify({
    action: overrides.action ?? 'created',
    installation: { uuid: 'test' },
    data: {
      issue: {
        id: overrides.id ?? '424242',
        shortId: 'YTB-INDEX-1A',
        title: 'TypeError: cannot read properties of undefined',
        culprit: 'src/server/routes/video.ts',
        level: overrides.level ?? 'error',
        status: overrides.status ?? 'unresolved',
        permalink: 'https://sentry.io/organizations/test/issues/424242/',
        fingerprint: ['{{ default }}'],
      },
    },
  });
}

/** POST a signed body to the hook route. */
function post(app: Hono, body: string, signature?: string): Promise<Response> {
  return Promise.resolve(
    app.request('/api/agent-hook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'sentry-hook-signature': signature ?? sign(body),
      },
      body,
    }),
  );
}

describe('POST /api/agent-hook', () => {
  it('dispatches agent-diagnose on a signed, created, error-level issue', async () => {
    const { app, calls } = harness();
    const response = await post(app, issueBody());

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { dispatched: 'YTB-INDEX-1A' });
    assert.equal(calls.length, 1);

    const call = calls[0];
    assert.ok(call !== undefined);
    assert.equal(call.url, 'https://api.github.com/repos/test-owner/test-repo/dispatches');
    const body = JSON.parse(String(call.init.body)) as {
      event_type: string;
      client_payload: { issue: Record<string, string> };
    };
    assert.equal(body.event_type, 'agent-diagnose');
    assert.equal(body.client_payload.issue.issueId, '424242');
    assert.equal(body.client_payload.issue.level, 'error');
    assert.equal(body.client_payload.issue.shortId, 'YTB-INDEX-1A');
  });

  it('rejects a wrong signature with 401 and never dispatches', async () => {
    const { app, calls } = harness();
    const body = issueBody({ id: '1' });
    const response = await post(app, body, sign(body, 'not-the-secret'));

    assert.equal(response.status, 401);
    assert.equal(calls.length, 0);
  });

  it('rejects a body mutated after signing with 401', async () => {
    const { app, calls } = harness();
    const body = issueBody({ id: '2' });
    const signature = sign(body);
    const tampered = body.replace('cannot read', 'cannot write');
    const response = await post(app, tampered, signature);

    assert.equal(response.status, 401);
    assert.equal(calls.length, 0);
  });

  it('ignores non-created actions', async () => {
    const { app, calls } = harness();
    const response = await post(app, issueBody({ action: 'updated', id: '3' }));

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { ignored: 'not a created issue' });
    assert.equal(calls.length, 0);
  });

  it('ignores non-error levels', async () => {
    const { app, calls } = harness();
    const response = await post(app, issueBody({ level: 'warning', id: '4' }));

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { ignored: 'level' });
    assert.equal(calls.length, 0);
  });

  it('ignores already-resolved issues', async () => {
    const { app, calls } = harness();
    const response = await post(app, issueBody({ status: 'resolved', id: '5' }));

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { ignored: 'status' });
    assert.equal(calls.length, 0);
  });

  it('debounces a second delivery for the same issue id', async () => {
    let clock = 1_000_000;
    const { app, calls } = harness({ now: () => new Date(clock) });
    const body = issueBody({ id: '6' });

    assert.equal((await post(app, body)).status, 202);
    clock += 60_000;
    const second = await post(app, body);

    assert.equal(second.status, 202);
    assert.deepEqual(await second.json(), { ignored: 'debounced' });
    assert.equal(calls.length, 1);
  });

  it('fails closed with 503 when the secret or PAT is missing', async () => {
    const { app, calls } = harness({ hookSecret: undefined });

    const response = await post(app, issueBody({ id: '7' }));

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'agent hook disabled' });
    assert.equal(calls.length, 0);
  });

  it('fails closed with 503 when the kill switch is off', async () => {
    const { app, calls } = harness({ enabled: false });

    const response = await post(app, issueBody({ id: '8' }));

    assert.equal(response.status, 503);
    assert.equal(calls.length, 0);
  });

  it('answers 502 and drops the debounce entry when dispatch fails', async () => {
    let attempts = 0;
    const transport: AgentDispatchTransport = async () => {
      attempts += 1;
      return new Response('nope', { status: 500 });
    };
    const { app } = harness({ transport });

    const first = await post(app, issueBody({ id: '9' }));
    const retry = await post(app, issueBody({ id: '9' }));

    assert.equal(first.status, 502);
    assert.equal(retry.status, 502);
    assert.equal(attempts, 2);
  });
});
