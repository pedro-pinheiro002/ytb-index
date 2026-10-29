/**
 * Integration tests for the server data loaders (`server/data.ts`) against an
 * in-memory better-sqlite3 catalog — the local half of the ADR-0002 executor
 * seam, so the same portable SQL runs on D1.
 *
 * Run via `pnpm test` (node:test runner).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Channel, VideoRecord } from '../shared/types.ts';
import { openCatalog, type SqliteExecutor } from '../db/sqlite.ts';
import { upsertChannel, upsertVideos } from '../db/queries.ts';
import { listChannels, loadCatalog, loadLatestIngestStatus } from './data.ts';

const CHANNEL_A: Channel = {
  id: 'UC_loader_a',
  title: 'Loader Channel A',
  uploadsPlaylistId: 'UU_loader_a',
  fetchedAt: '2026-01-01T00:00:00.000Z',
};

const CHANNEL_B: Channel = {
  id: 'UC_loader_b',
  title: 'Loader Channel B',
  uploadsPlaylistId: 'UU_loader_b',
  fetchedAt: '2026-02-01T00:00:00.000Z',
};

function video(id: string, channel: Channel, publishedAt: string): VideoRecord {
  return {
    id,
    channelId: channel.id,
    title: `Video ${id}`,
    description: '',
    publishedAt,
    thumbnailUrl: `https://example.com/${id}.jpg`,
    durationIso8601: 'PT1M',
    viewCount: 1,
    likeCount: 0,
    commentCount: 0,
    fetchedAt: channel.fetchedAt,
  };
}

/** Two channels, each with two videos, oldest channel seeded first. */
async function seed(db: SqliteExecutor): Promise<void> {
  await upsertChannel(db, CHANNEL_A);
  await upsertVideos(db, [
    video('a-old', CHANNEL_A, '2020-01-01T00:00:00.000Z'),
    video('a-new', CHANNEL_A, '2021-01-01T00:00:00.000Z'),
  ]);
  await upsertChannel(db, CHANNEL_B);
  await upsertVideos(db, [
    video('b-old', CHANNEL_B, '2022-01-01T00:00:00.000Z'),
    video('b-new', CHANNEL_B, '2023-01-01T00:00:00.000Z'),
  ]);
}

/** Insert one `ingest_requests` row directly (no write helpers in the API lane). */
async function insertRequest(
  db: SqliteExecutor,
  row: {
    id: string;
    status: string;
    createdAt: string;
    channelKey?: string;
    channelId?: string | null;
    videosWritten?: number;
    commentsWritten?: number;
    error?: string | null;
  },
): Promise<void> {
  await db.run(
    `INSERT INTO ingest_requests (
       id, channel_input, channel_key, channel_id, status,
       videos_written, comments_written, error, created_at, updated_at, finished_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      '@input',
      row.channelKey ?? '@input',
      row.channelId ?? null,
      row.status,
      row.videosWritten ?? 0,
      row.commentsWritten ?? 0,
      row.error ?? null,
      row.createdAt,
      row.createdAt,
      row.status === 'done' || row.status === 'failed' ? row.createdAt : null,
    ],
  );
}

describe('server data loaders', () => {
  it('loadCatalog() returns the most recent channel with only its videos, newest-first', async () => {
    const db = await openCatalog(':memory:');
    try {
      await seed(db);
      const catalog = await loadCatalog(db);
      assert.notEqual(catalog, null);
      assert.equal(catalog?.channel.id, CHANNEL_B.id);
      assert.equal(catalog?.channel.title, CHANNEL_B.title);
      assert.deepEqual(
        catalog?.videos.map((v) => v.id),
        ['b-new', 'b-old'],
      );
    } finally {
      db.close();
    }
  });

  it('loadCatalog(channelId) returns that channel regardless of recency', async () => {
    const db = await openCatalog(':memory:');
    try {
      await seed(db);
      const catalog = await loadCatalog(db, CHANNEL_A.id);
      assert.equal(catalog?.channel.id, CHANNEL_A.id);
      assert.deepEqual(
        catalog?.videos.map((v) => v.id),
        ['a-new', 'a-old'],
      );
    } finally {
      db.close();
    }
  });

  it('loadCatalog() is null before any ingest and for an unknown channel id', async () => {
    const db = await openCatalog(':memory:');
    try {
      assert.equal(await loadCatalog(db), null);
      await seed(db);
      assert.equal(await loadCatalog(db, 'UC_missing'), null);
    } finally {
      db.close();
    }
  });

  it('listChannels() lists every channel, most recently fetched first', async () => {
    const db = await openCatalog(':memory:');
    try {
      assert.deepEqual(await listChannels(db), []);
      await seed(db);
      assert.deepEqual(await listChannels(db), [
        { id: CHANNEL_B.id, channelId: CHANNEL_B.id, title: CHANNEL_B.title },
        { id: CHANNEL_A.id, channelId: CHANNEL_A.id, title: CHANNEL_A.title },
      ]);
    } finally {
      db.close();
    }
  });

  it('loadLatestIngestStatus() is null before any request, then returns the newest row', async () => {
    const db = await openCatalog(':memory:');
    try {
      assert.equal(await loadLatestIngestStatus(db), null);

      await insertRequest(db, {
        id: 'older',
        status: 'done',
        createdAt: '2026-03-01T00:00:00.000Z',
        videosWritten: 4,
        commentsWritten: 9,
      });
      await insertRequest(db, {
        id: 'newer',
        status: 'running',
        createdAt: '2026-03-02T00:00:00.000Z',
        channelKey: '@mkbhd',
        channelId: 'UC_mkbhd',
      });

      assert.deepEqual(await loadLatestIngestStatus(db), {
        id: 'newer',
        channelInput: '@input',
        channelKey: '@mkbhd',
        channelId: 'UC_mkbhd',
        status: 'running',
        videosWritten: 0,
        commentsWritten: 0,
        repliesWritten: 0,
        chatMessagesWritten: 0,
        skippedVideos: 0,
        quotaUsed: 0,
        keySource: 'repo',
        captureLiveChat: false,
        error: null,
        createdAt: '2026-03-02T00:00:00.000Z',
        updatedAt: '2026-03-02T00:00:00.000Z',
        finishedAt: null,
      });
    } finally {
      db.close();
    }
  });
});
