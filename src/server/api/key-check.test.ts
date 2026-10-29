/**
 * Integration tests for the OperatorKey check (`POST /api/key/check`,
 * F6 #51, ADR-0007).
 *
 * Every case drives the real app (`createApp`) with an injected key-check
 * transport that replays a Google error envelope, so the token gate, the local
 * shape check and the verdict mapping all run without network.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openCatalog } from '../../db/sqlite.ts';
import { createApp } from '../app.ts';
import type { KeyCheckTransport } from './key-check.ts';

const OPERATOR_TOKEN = 'test-operator-token';
const VALID_KEY = `AIza${'k'.repeat(35)}`;

/** A Google API error envelope as YouTube returns it. */
function googleError(
  code: number,
  options: { reason?: string; status?: string; detailReason?: string } = {},
): Response {
  const body = {
    error: {
      code,
      message: 'google says no',
      errors:
        options.reason === undefined
          ? []
          : [{ message: 'google says no', domain: 'global', reason: options.reason }],
      ...(options.status !== undefined ? { status: options.status } : {}),
      ...(options.detailReason !== undefined
        ? {
            details: [
              {
                '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                reason: options.detailReason,
                domain: 'googleapis.com',
              },
            ],
          }
        : {}),
    },
  };
  return new Response(JSON.stringify(body), {
    status: code,
    headers: { 'content-type': 'application/json' },
  });
}

/** Transport double: records every URL and answers with `reply`. */
function fakeTransport(reply: Response | Error): {
  transport: KeyCheckTransport;
  urls: string[];
} {
  const urls: string[] = [];
  const transport: KeyCheckTransport = async (url) => {
    urls.push(url);
    if (reply instanceof Error) throw reply;
    return reply.clone();
  };
  return { transport, urls };
}

async function postCheck(
  transport: KeyCheckTransport,
  body: unknown,
  token: string | null = OPERATOR_TOKEN,
): Promise<Response> {
  const db = await openCatalog(':memory:');
  const app = await createApp({
    db,
    ingest: { operatorToken: OPERATOR_TOKEN, keyCheckTransport: transport },
  });
  const headers = new Headers({ 'content-type': 'application/json' });
  if (token !== null) headers.set('authorization', `Bearer ${token}`);
  return await app.request('/api/key/check', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('POST /api/key/check', () => {
  it('answers ok for a key YouTube accepts, with one channels.list?part=id call', async () => {
    const { transport, urls } = fakeTransport(
      new Response(JSON.stringify({ items: [{ id: 'UC_x5XG1OV2P6uZZ5FSM9Ttw' }] }), {
        status: 200,
      }),
    );
    const res = await postCheck(transport, { key: VALID_KEY });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(urls.length, 1);
    const url = new URL(urls[0] ?? '');
    assert.equal(url.origin + url.pathname, 'https://www.googleapis.com/youtube/v3/channels');
    assert.equal(url.searchParams.get('part'), 'id');
    assert.equal(url.searchParams.get('id'), 'UC_x5XG1OV2P6uZZ5FSM9Ttw');
    assert.equal(url.searchParams.get('key'), VALID_KEY);
  });

  const verdicts: Array<{ name: string; reply: Response | Error; reason: string }> = [
    {
      name: '400 keyInvalid',
      reply: googleError(400, { reason: 'keyInvalid' }),
      reason: 'invalid',
    },
    {
      name: '400 INVALID_ARGUMENT / API_KEY_INVALID',
      reply: googleError(400, {
        reason: 'badRequest',
        status: 'INVALID_ARGUMENT',
        detailReason: 'API_KEY_INVALID',
      }),
      reason: 'invalid',
    },
    {
      name: '403 quotaExceeded',
      reply: googleError(403, { reason: 'quotaExceeded' }),
      reason: 'quotaExceeded',
    },
    {
      name: '403 accessNotConfigured',
      reply: googleError(403, { reason: 'accessNotConfigured', status: 'PERMISSION_DENIED' }),
      reason: 'apiNotEnabled',
    },
    {
      name: '403 SERVICE_DISABLED',
      reply: googleError(403, { status: 'PERMISSION_DENIED', detailReason: 'SERVICE_DISABLED' }),
      reason: 'apiNotEnabled',
    },
    {
      name: '403 ipRefererBlocked',
      reply: googleError(403, { reason: 'ipRefererBlocked' }),
      reason: 'restricted',
    },
    {
      name: '403 forbidden',
      reply: googleError(403, { reason: 'forbidden' }),
      reason: 'restricted',
    },
    {
      name: '403 API_KEY_HTTP_REFERRER_BLOCKED',
      reply: googleError(403, {
        status: 'PERMISSION_DENIED',
        detailReason: 'API_KEY_HTTP_REFERRER_BLOCKED',
      }),
      reason: 'restricted',
    },
    {
      // A short-term rate limit, not the daily quota: retry, no midnight-PT message.
      name: '403 rateLimitExceeded',
      reply: googleError(403, { reason: 'rateLimitExceeded' }),
      reason: 'unavailable',
    },
    { name: '503', reply: googleError(503, { reason: 'backendError' }), reason: 'unavailable' },
    { name: 'network error', reply: new TypeError('fetch failed'), reason: 'unavailable' },
  ];

  for (const { name, reply, reason } of verdicts) {
    it(`maps ${name} to ${reason}`, async () => {
      const { transport } = fakeTransport(reply);
      const res = await postCheck(transport, { key: VALID_KEY });
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(!text.includes(VALID_KEY), 'the verdict never echoes the key');
      const body = JSON.parse(text) as { ok: boolean; reason: string; message: string };
      assert.equal(body.ok, false);
      assert.equal(body.reason, reason);
      assert.ok(body.message.length > 0);
    });
  }

  it('says when quota resets', async () => {
    const { transport } = fakeTransport(googleError(403, { reason: 'quotaExceeded' }));
    const body = (await (await postCheck(transport, { key: VALID_KEY })).json()) as {
      message: string;
    };
    assert.match(body.message, /midnight Pacific Time/);
  });

  it('rejects a malformed or missing key locally, without calling YouTube', async () => {
    const { transport, urls } = fakeTransport(new Response('{}', { status: 200 }));
    assert.deepEqual(
      ((await (await postCheck(transport, { key: 'AIzaShort' })).json()) as { reason: string })
        .reason,
      'malformed',
    );
    assert.deepEqual(
      ((await (await postCheck(transport, {})).json()) as { reason: string }).reason,
      'missing',
    );
    assert.deepEqual(
      ((await (await postCheck(transport, { key: '  ' })).json()) as { reason: string }).reason,
      'missing',
    );
    assert.equal(urls.length, 0);
  });

  it('answers 401 without the operator token, without calling YouTube', async () => {
    const { transport, urls } = fakeTransport(new Response('{}', { status: 200 }));
    assert.equal((await postCheck(transport, { key: VALID_KEY }, null)).status, 401);
    assert.equal((await postCheck(transport, { key: VALID_KEY }, 'wrong')).status, 401);
    assert.equal(urls.length, 0);
  });
});
