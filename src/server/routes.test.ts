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
import { openSqlite, type DbHandle } from '../db/sqlite.ts';
import { upsertAnchors, upsertChannel, upsertComments, upsertVideos } from '../db/queries.ts';
import { createApp } from './index.ts';

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
function seededApp(): { app: ReturnType<typeof createApp>; db: DbHandle } {
  const db = openSqlite(':memory:');
  upsertChannel(db, CHANNEL);
  upsertVideos(db, [VIDEO]);
  upsertComments(db, [COMMENT]);
  upsertAnchors(db, [ANCHOR]);
  return { app: createApp({ db }), db };
}

describe('server routes', () => {
  it('GET / renders the catalog as HTML', async () => {
    const { app, db } = seededApp();
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
    const { app, db } = seededApp();
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

  it('GET /v/:videoId returns a text/html 404 for an unknown video', async () => {
    const { app, db } = seededApp();
    try {
      const res = await app.fetch(new Request('http://localhost/v/missing'));
      assert.equal(res.status, 404);
      assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    } finally {
      db.close();
    }
  });
});
