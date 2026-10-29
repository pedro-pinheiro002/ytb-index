/**
 * Integration tests for the operator ingest API (`server/api/ingest`).
 *
 * Every case drives the real app (`createApp`) over a fresh `:memory:`
 * database with an injected dispatch transport, so auth, input validation,
 * the one-active-request rule, the `repository_dispatch` call, and the public
 * status read all run end-to-end without network.
 *
 * Run via `pnpm test` (node:test runner).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openCatalog, type SqliteExecutor } from '../../db/sqlite.ts';
import { createApp } from '../app.ts';
import { normalizeChannelInput } from './channel-input.ts';
import type { DispatchTransport } from './github-dispatch.ts';

const OPERATOR_TOKEN = 'test-operator-token';
const DISPATCH_PAT = 'ghp_test_pat';
const GH_OWNER = 'test-owner';
const GH_REPO = 'test-repo';
const UC_ID = `UC${'A'.repeat(22)}`;

interface DispatchCall {
  url: string;
  init: RequestInit;
}

/** Transport double: records every call, replays the given replies in order. */
function fakeTransport(...replies: Array<Response | Error>): {
  transport: DispatchTransport;
  calls: DispatchCall[];
} {
  const calls: DispatchCall[] = [];
  let index = 0;
  const transport: DispatchTransport = async (url, init) => {
    calls.push({ url, init });
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    if (reply instanceof Error) {
      throw reply;
    }
    return reply ?? new Response(null, { status: 204 });
  };
  return { transport, calls };
}

/** Deterministic, strictly increasing clock. */
function tickingClock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));
}

/** Deterministic id generator. */
function counterUuid(): () => string {
  let count = 0;
  return () => `req-${++count}`;
}

interface TestApp {
  app: Awaited<ReturnType<typeof createApp>>;
  db: SqliteExecutor;
}

async function testApp(
  options: {
    transport?: DispatchTransport;
    now?: () => Date;
    uuid?: () => string;
    /** `null` explicitly means "no OPERATOR_TOKEN configured"; omit for the default. */
    operatorToken?: string | null;
  } = {},
): Promise<TestApp> {
  const db = await openCatalog(':memory:');
  const app = await createApp({
    db,
    ingest: {
      operatorToken:
        options.operatorToken === null ? undefined : (options.operatorToken ?? OPERATOR_TOKEN),
      dispatchPat: DISPATCH_PAT,
      ghOwner: GH_OWNER,
      ghRepo: GH_REPO,
      transport: options.transport,
      now: options.now ?? tickingClock(),
      uuid: options.uuid ?? counterUuid(),
    },
  });
  return { app, db };
}

async function postIngest(
  app: TestApp['app'],
  channel: unknown,
  token: string | null = OPERATOR_TOKEN,
): Promise<Response> {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (token !== null) {
    headers.set('authorization', `Bearer ${token}`);
  }
  return await app.fetch(
    new Request('http://localhost/api/ingest', {
      method: 'POST',
      headers,
      body: JSON.stringify({ channel }),
    }),
  );
}

async function requestRows(db: SqliteExecutor): Promise<
  Array<{
    id: string;
    channel_input: string;
    channel_key: string;
    status: string;
    error: string | null;
  }>
> {
  return db.all(
    'SELECT id, channel_input, channel_key, status, error FROM ingest_requests ORDER BY created_at',
  );
}

describe('normalizeChannelInput', () => {
  it('accepts the CLI shapes and derives the channel_key', () => {
    assert.deepEqual(normalizeChannelInput('@MKBHD'), { ok: true, channelKey: '@mkbhd' });
    assert.deepEqual(normalizeChannelInput('mkbhd'), { ok: true, channelKey: '@mkbhd' });
    assert.deepEqual(normalizeChannelInput(UC_ID), { ok: true, channelKey: UC_ID });
    assert.deepEqual(normalizeChannelInput(`https://www.youtube.com/channel/${UC_ID}`), {
      ok: true,
      channelKey: UC_ID,
    });
    assert.deepEqual(normalizeChannelInput('https://youtube.com/@MKBHD/'), {
      ok: true,
      channelKey: '@mkbhd',
    });
  });

  it('rejects whitespace, malformed ids, and unknown shapes', () => {
    for (const bad of [
      '',
      'a b',
      'UCshort',
      `UC${'A'.repeat(21)}`,
      'https://example.com/@x',
      '!!',
    ]) {
      const result = normalizeChannelInput(bad);
      assert.equal(result.ok, false, `expected "${bad}" to be rejected`);
    }
  });
});

describe('POST /api/ingest', () => {
  it('rejects missing and wrong bearer tokens without touching the database', async () => {
    const { app, db } = await testApp();
    try {
      const missing = await postIngest(app, '@mkbhd', null);
      assert.equal(missing.status, 401);

      const wrong = await postIngest(app, '@mkbhd', 'not-the-token');
      assert.equal(wrong.status, 401);

      const scheme = await app.fetch(
        new Request('http://localhost/api/ingest', {
          method: 'POST',
          headers: { authorization: `Token ${OPERATOR_TOKEN}`, 'content-type': 'application/json' },
          body: JSON.stringify({ channel: '@mkbhd' }),
        }),
      );
      assert.equal(scheme.status, 401);

      assert.deepEqual(await requestRows(db), []);
    } finally {
      db.close();
    }
  });

  it('fails closed when no operator token is configured', async () => {
    const { app, db } = await testApp({ operatorToken: null });
    try {
      assert.equal((await postIngest(app, '@mkbhd')).status, 401);
    } finally {
      db.close();
    }
  });

  it('rejects invalid bodies and invalid channel inputs with 400', async () => {
    const { app, db } = await testApp();
    try {
      assert.equal((await postIngest(app, 42)).status, 400);
      assert.equal((await postIngest(app, 'two words')).status, 400);
      assert.equal((await postIngest(app, 'https://example.com/@mkbhd')).status, 400);

      const invalidJson = await app.fetch(
        new Request('http://localhost/api/ingest', {
          method: 'POST',
          headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
          body: '{not json',
        }),
      );
      assert.equal(invalidJson.status, 400);
      assert.deepEqual(await requestRows(db), []);
    } finally {
      db.close();
    }
  });

  it('queues the request and dispatches with the raw input', async () => {
    const { transport, calls } = fakeTransport(new Response(null, { status: 204 }));
    const { app, db } = await testApp({ transport });
    try {
      const res = await postIngest(app, '@MKBHD');
      assert.equal(res.status, 202);
      assert.deepEqual(await res.json(), { requestId: 'req-1' });

      const rows = await requestRows(db);
      assert.deepEqual(rows, [
        {
          id: 'req-1',
          channel_input: '@MKBHD',
          channel_key: '@mkbhd',
          status: 'queued',
          error: null,
        },
      ]);

      assert.equal(calls.length, 1);
      const call = calls[0];
      assert.equal(call?.url, `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/dispatches`);
      const headers = new Headers(call?.init.headers);
      assert.equal(headers.get('authorization'), `Bearer ${DISPATCH_PAT}`);
      assert.equal(headers.get('accept'), 'application/vnd.github+json');
      assert.deepEqual(JSON.parse(String(call?.init.body)), {
        event_type: 'ingest',
        client_payload: { requestId: 'req-1', channel: '@MKBHD', captureLiveChat: false },
      });
    } finally {
      db.close();
    }
  });

  it('rejects a second active request for the same channel_key with 409', async () => {
    const { transport, calls } = fakeTransport(new Response(null, { status: 204 }));
    const { app, db } = await testApp({ transport });
    try {
      assert.equal((await postIngest(app, '@MKBHD')).status, 202);
      const second = await postIngest(app, 'mkbhd');
      assert.equal(second.status, 409);
      assert.deepEqual(await second.json(), { requestId: 'req-1' });

      // A UC… id and its /channel/ URL normalize to the same key.
      assert.equal((await postIngest(app, UC_ID)).status, 202);
      assert.equal((await postIngest(app, `https://www.youtube.com/channel/${UC_ID}`)).status, 409);

      assert.equal(calls.length, 2);
      assert.equal((await requestRows(db)).length, 2);
    } finally {
      db.close();
    }
  });

  it('reclaims an active request older than the runner limit, but not a fresh one', async () => {
    const { transport } = fakeTransport(new Response(null, { status: 204 }));
    const start = Date.UTC(2026, 0, 1, 0, 0, 0);
    let current = start;
    const { app, db } = await testApp({ transport, now: () => new Date(current) });
    try {
      assert.equal((await postIngest(app, '@MKBHD')).status, 202);

      current = start + 5 * 60 * 60 * 1000 + 59 * 60 * 1000;
      const fresh = await postIngest(app, '@MKBHD');
      assert.equal(fresh.status, 409);
      assert.deepEqual(await fresh.json(), { requestId: 'req-1' });

      current = start + 6 * 60 * 60 * 1000 + 60 * 1000;
      const reclaimed = await postIngest(app, '@MKBHD');
      assert.equal(reclaimed.status, 202);
      assert.deepEqual(await reclaimed.json(), { requestId: 'req-2' });

      const rows = await requestRows(db);
      assert.deepEqual(
        rows.map((row) => [row.id, row.status, row.error?.startsWith('stale:') ?? false]),
        [
          ['req-1', 'failed', true],
          ['req-2', 'queued', false],
        ],
      );
    } finally {
      db.close();
    }
  });

  it('accepts a new request once the previous one is done', async () => {
    const { transport } = fakeTransport(new Response(null, { status: 204 }));
    const { app, db } = await testApp({ transport });
    try {
      await db.run(
        `INSERT INTO ingest_requests (
           id, channel_input, channel_key, channel_id, status,
           videos_written, comments_written, error, created_at, updated_at, finished_at
         ) VALUES (?, ?, ?, ?, 'done', 3, 4, NULL, ?, ?, ?)`,
        [
          'old',
          '@mkbhd',
          '@mkbhd',
          UC_ID,
          '2025-12-31T00:00:00.000Z',
          '2025-12-31T00:00:00.000Z',
          '2025-12-31T00:00:00.000Z',
        ],
      );
      assert.equal((await postIngest(app, '@mkbhd')).status, 202);
    } finally {
      db.close();
    }
  });

  it('marks the row failed and answers 502 when GitHub rejects the dispatch', async () => {
    const { transport } = fakeTransport(new Response(null, { status: 422 }));
    const { app, db } = await testApp({ transport });
    try {
      const res = await postIngest(app, '@mkbhd');
      assert.equal(res.status, 502);
      assert.deepEqual(await res.json(), { error: 'dispatch failed' });

      const row = await db.get<{ status: string; error: string; finished_at: string }>(
        'SELECT status, error, finished_at FROM ingest_requests WHERE id = ?',
        ['req-1'],
      );
      assert.equal(row?.status, 'failed');
      assert.equal(row?.error, 'dispatch failed');
      assert.equal(typeof row?.finished_at, 'string');
    } finally {
      db.close();
    }
  });

  it('marks the row failed and answers 502 when the dispatch throws', async () => {
    const { transport } = fakeTransport(new Error('network down'));
    const { app, db } = await testApp({ transport });
    try {
      assert.equal((await postIngest(app, '@mkbhd')).status, 502);
      const row = await db.get<{ status: string }>(
        'SELECT status FROM ingest_requests WHERE id = ?',
        ['req-1'],
      );
      assert.equal(row?.status, 'failed');
    } finally {
      db.close();
    }
  });
});

describe('GET /api/ingest/status', () => {
  it('is public and answers 204 with no body when no request exists', async () => {
    const { app, db } = await testApp();
    try {
      const res = await app.fetch(new Request('http://localhost/api/ingest/status'));
      assert.equal(res.status, 204);
      assert.equal(await res.text(), '');
    } finally {
      db.close();
    }
  });

  it('returns the latest request as the documented JSON shape', async () => {
    const { transport } = fakeTransport(new Response(null, { status: 204 }));
    const { app, db } = await testApp({ transport });
    try {
      await postIngest(app, '@mkbhd');

      const res = await app.fetch(new Request('http://localhost/api/ingest/status'));
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        requestId: 'req-1',
        channelId: null,
        status: 'queued',
        videosWritten: 0,
        commentsWritten: 0,
        repliesWritten: 0,
        chatMessagesWritten: 0,
        skippedVideos: 0,
        quotaUsed: 0,
        error: null,
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
    } finally {
      db.close();
    }
  });

  it('returns the newest row once the runner has updated it', async () => {
    const { transport } = fakeTransport(new Response(null, { status: 204 }));
    const { app, db } = await testApp({ transport });
    try {
      await postIngest(app, '@mkbhd');
      await db.run(
        `UPDATE ingest_requests
         SET status = 'done', channel_id = ?, videos_written = 12, comments_written = 34,
             replies_written = 5, chat_messages_written = 7, skipped_videos = 2, quota_used = 91,
             updated_at = ?, finished_at = ?
         WHERE id = ?`,
        [UC_ID, '2026-01-01T00:05:00.000Z', '2026-01-01T00:05:00.000Z', 'req-1'],
      );

      const res = await app.fetch(new Request('http://localhost/api/ingest/status'));
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        requestId: 'req-1',
        channelId: UC_ID,
        status: 'done',
        videosWritten: 12,
        commentsWritten: 34,
        repliesWritten: 5,
        chatMessagesWritten: 7,
        skippedVideos: 2,
        quotaUsed: 91,
        error: null,
        updatedAt: '2026-01-01T00:05:00.000Z',
      });
    } finally {
      db.close();
    }
  });
});
