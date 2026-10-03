/**
 * Integration tests for `src/db/queries.ts` against an in-memory database.
 *
 * Covers the shape and ordering of the read paths, the TTL-view fields, the
 * anchor de-duplication rule, and full-upsert idempotency.
 *
 * Run via `pnpm test` (node:test runner).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Channel, CommentRecord, TimeAnchor, VideoRecord } from '../shared/types.ts';
import { openSqlite, type DbHandle } from './sqlite.ts';
import {
  channelLastRefreshed,
  listCatalog,
  listVideoComments,
  upsertAnchors,
  upsertChannel,
  upsertComments,
  upsertVideos,
} from './queries.ts';

const CHANNEL: Channel = {
  id: 'UC_test_channel',
  title: 'Test Channel',
  uploadsPlaylistId: 'UU_test_channel',
  fetchedAt: new Date().toISOString(),
};

function video(id: string, publishedAt: string): VideoRecord {
  return {
    id,
    channelId: CHANNEL.id,
    title: `Video ${id}`,
    description: `Description ${id}`,
    publishedAt,
    thumbnailUrl: `https://example.com/${id}.jpg`,
    durationIso8601: 'PT5M32S',
    viewCount: 100,
    likeCount: 10,
    commentCount: 2,
    fetchedAt: CHANNEL.fetchedAt,
  };
}

const VIDEOS: VideoRecord[] = [
  video('v1', '2020-01-01T00:00:00.000Z'),
  video('v2', '2021-01-01T00:00:00.000Z'),
];

function comment(id: string, videoId: string, publishedAt: string): CommentRecord {
  return {
    id,
    videoId,
    channelId: CHANNEL.id,
    author: `Author ${id}`,
    text: `Comment ${id}`,
    publishedAt,
    likeCount: 3,
    hasAnchors: 0,
    fetchedAt: CHANNEL.fetchedAt,
  };
}

const COMMENTS: CommentRecord[] = [
  comment('c1', 'v1', '2020-06-01T00:00:00.000Z'),
  comment('c2', 'v1', '2020-07-01T00:00:00.000Z'),
];

const ANCHORS: TimeAnchor[] = [{ commentId: 'c1', seconds: 60, rawText: '1:00', charPosition: 50 }];

function seed(db: DbHandle): void {
  upsertChannel(db, CHANNEL);
  upsertVideos(db, VIDEOS);
  upsertComments(db, COMMENTS);
  upsertAnchors(db, ANCHORS);
}

describe('db queries', () => {
  it('listCatalog returns videos newest-first by published_at', () => {
    const db = openSqlite(':memory:');
    try {
      seed(db);
      const catalog = listCatalog(db);
      assert.deepEqual(
        catalog.map((v) => v.id),
        ['v2', 'v1'],
      );
      // Full shape round-trips (snake_case columns → camelCase fields).
      assert.deepEqual(catalog[0], VIDEOS[1]);
    } finally {
      db.close();
    }
  });

  it('listCatalog is empty before any ingest', () => {
    const db = openSqlite(':memory:');
    try {
      assert.deepEqual(listCatalog(db), []);
    } finally {
      db.close();
    }
  });

  it('listVideoComments returns comments newest-first with view fields', () => {
    const db = openSqlite(':memory:');
    try {
      seed(db);
      const comments = listVideoComments(db, 'v1');
      assert.deepEqual(
        comments.map((c) => c.id),
        ['c2', 'c1'],
      );
      for (const c of comments) {
        assert.equal(typeof c.expiresAt, 'string');
        assert.equal(c.isExpired, false);
      }
      assert.equal(comments[0]?.text, 'Comment c2');
    } finally {
      db.close();
    }
  });

  it('listVideoComments scopes to the requested video', () => {
    const db = openSqlite(':memory:');
    try {
      seed(db);
      assert.deepEqual(listVideoComments(db, 'v2'), []);
    } finally {
      db.close();
    }
  });

  it('channelLastRefreshed returns the seeded fetched_at', () => {
    const db = openSqlite(':memory:');
    try {
      seed(db);
      assert.equal(channelLastRefreshed(db), CHANNEL.fetchedAt);
    } finally {
      db.close();
    }
  });

  it('channelLastRefreshed returns null when no channel exists', () => {
    const db = openSqlite(':memory:');
    try {
      assert.equal(channelLastRefreshed(db), null);
    } finally {
      db.close();
    }
  });

  it('upsertAnchors keeps the earliest char_position on conflict', () => {
    const db = openSqlite(':memory:');
    try {
      seed(db);
      upsertAnchors(db, [{ commentId: 'c1', seconds: 60, rawText: '1:00', charPosition: 10 }]);
      const row = db
        .prepare(
          'SELECT raw_text, char_position FROM time_anchors WHERE comment_id = ? AND seconds = ?',
        )
        .get('c1', 60) as { raw_text: string; char_position: number };
      assert.equal(row.char_position, 10);
      assert.equal(row.raw_text, '1:00');
      const count = db
        .prepare('SELECT COUNT(*) AS n FROM time_anchors WHERE comment_id = ? AND seconds = ?')
        .get('c1', 60) as { n: number };
      assert.equal(count.n, 1);
    } finally {
      db.close();
    }
  });

  it('running every upsert twice is idempotent', () => {
    const db = openSqlite(':memory:');
    try {
      seed(db);
      const firstCatalog = listCatalog(db);
      const firstComments = listVideoComments(db, 'v1');
      const firstRefreshed = channelLastRefreshed(db);

      // Second pass over the same data.
      seed(db);

      assert.deepEqual(listCatalog(db), firstCatalog);
      assert.deepEqual(listVideoComments(db, 'v1'), firstComments);
      assert.equal(channelLastRefreshed(db), firstRefreshed);

      const counts = db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM channels) AS channels,
             (SELECT COUNT(*) FROM videos) AS videos,
             (SELECT COUNT(*) FROM comments) AS comments,
             (SELECT COUNT(*) FROM time_anchors) AS anchors`,
        )
        .get() as { channels: number; videos: number; comments: number; anchors: number };
      assert.deepEqual(counts, { channels: 1, videos: 2, comments: 2, anchors: 1 });
    } finally {
      db.close();
    }
  });
});
