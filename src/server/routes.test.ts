/**
 * Integration tests for the Hono routes in `src/server`.
 *
 * Each case builds the real app (`createApp`) around a seeded `:memory:`
 * database and drives it through `app.fetch`, so routing, DB reads, and SSR all
 * run end-to-end.
 *
 * Run via `pnpm test` (node:test runner, through tsx).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Channel, CommentRecord, TimeAnchor, VideoRecord } from '../shared/types.ts';
import type { Executor, Statement } from '../db/executor.ts';
import { openCatalog, type SqliteExecutor } from '../db/sqlite.ts';
import { upsertAnchors, upsertChannel, upsertComments, upsertVideos } from '../db/queries.ts';
import { createApp } from './app.ts';

const CHANNEL: Channel = {
  id: 'UC_int_channel',
  title: 'Integration Channel',
  uploadsPlaylistId: 'UU_int_channel',
  fetchedAt: '2026-05-01T00:00:00.000Z',
};

const VIDEO: VideoRecord = {
  id: 'vid-int',
  channelId: CHANNEL.id,
  title: 'Integration Video',
  description: '',
  publishedAt: new Date().toISOString(),
  thumbnailUrl: 'https://example.com/int.jpg',
  durationIso8601: 'PT1M',
  viewCount: 1,
  likeCount: 0,
  commentCount: 1,
  fetchedAt: CHANNEL.fetchedAt,
};

const COMMENT: CommentRecord = {
  id: 'c-int',
  videoId: VIDEO.id,
  channelId: CHANNEL.id,
  author: 'Bob',
  text: 'Jump to 1:23',
  publishedAt: new Date().toISOString(),
  likeCount: 1,
  hasAnchors: 1,
  fetchedAt: CHANNEL.fetchedAt,
};

const ANCHOR: TimeAnchor = { commentId: COMMENT.id, seconds: 83, rawText: '1:23', charPosition: 8 };

/** Seed an in-memory catalog and wrap it in the real app. */
async function seededApp(): Promise<{
  app: Awaited<ReturnType<typeof createApp>>;
  db: SqliteExecutor;
}> {
  const db = await openCatalog(':memory:');
  await upsertChannel(db, CHANNEL);
  await upsertVideos(db, [VIDEO]);
  await upsertComments(db, [COMMENT]);
  await upsertAnchors(db, [ANCHOR]);
  const app = await createApp({ db });
  return { app, db };
}

describe('server routes', () => {
  it('GET / renders the catalog as HTML', async () => {
    const { app, db } = await seededApp();
    try {
      const res = await app.fetch(new Request('http://localhost/'));
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /text\/html/);
      const body = await res.text();
      assert.ok(body.includes('Integration Video'));
      assert.ok(body.includes('Last refreshed: 2026-05-01'));
    } finally {
      db.close();
    }
  });

  it('GET /v/:videoId renders the video detail as HTML', async () => {
    const { app, db } = await seededApp();
    try {
      const res = await app.fetch(new Request('http://localhost/v/vid-int'));
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /text\/html/);
      const body = await res.text();
      assert.ok(body.includes('Watch on YouTube'));
      assert.ok(body.includes('https://www.youtube.com/watch?v=vid-int&t=83s'));
    } finally {
      db.close();
    }
  });

  it('GET /v/:videoId looks the video up by id, never scanning the whole Catalog', async () => {
    const { db } = await seededApp();
    try {
      const executed: string[] = [];
      const recording: Executor = {
        all<T>(sql: string, params?: unknown[]): Promise<T[]> {
          executed.push(sql);
          return db.all<T>(sql, params);
        },
        get<T>(sql: string, params?: unknown[]): Promise<T | undefined> {
          executed.push(sql);
          return db.get<T>(sql, params);
        },
        run(sql: string, params?: unknown[]): Promise<number> {
          executed.push(sql);
          return db.run(sql, params);
        },
        batch(statements: Statement[]): Promise<void> {
          executed.push(...statements.map((statement) => statement.sql));
          return db.batch(statements);
        },
      };
      const app = await createApp({ db: recording });

      for (const videoId of ['vid-int', 'missing']) {
        executed.length = 0;
        const res = await app.request(`/v/${videoId}`);
        assert.equal(res.status, videoId === 'missing' ? 404 : 200);
        const videoReads = executed.filter((sql) => /\bFROM\s+videos\b/i.test(sql));
        assert.deepEqual(
          videoReads.filter((sql) => !/\bWHERE\b/i.test(sql)),
          [],
          'no unfiltered SELECT … FROM videos',
        );
        assert.equal(videoReads.length, 1, `exactly one videos read for ${videoId}`);
        assert.match(videoReads[0] ?? '', /\bWHERE\s+id\s*=\s*\?/i);
      }
    } finally {
      db.close();
    }
  });

  it('GET /v/:videoId returns a text/html 404 for an unknown video', async () => {
    const { app, db } = await seededApp();
    try {
      const res = await app.fetch(new Request('http://localhost/v/missing'));
      assert.equal(res.status, 404);
      assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    } finally {
      db.close();
    }
  });

  it('GET /c/:channelId renders the explicit channel catalog', async () => {
    const { app, db } = await seededApp();
    try {
      const res = await app.fetch(new Request('http://localhost/c/UC_int_channel'));
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /text\/html/);
      const body = await res.text();
      assert.ok(body.includes('Integration Video'));
      assert.ok(body.includes('value="UC_int_channel" selected'));
    } finally {
      db.close();
    }
  });

  it('GET /c/:channelId returns a text/html 404 for an unknown channel', async () => {
    const { app, db } = await seededApp();
    try {
      const res = await app.fetch(new Request('http://localhost/c/UC_missing'));
      assert.equal(res.status, 404);
      assert.match(res.headers.get('content-type') ?? '', /text\/html/);
      const body = await res.text();
      assert.ok(body.includes('Unknown channel'));
    } finally {
      db.close();
    }
  });
});
