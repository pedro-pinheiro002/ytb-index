/**
 * Integration tests for `migrations/0003_v2_catalog.sql` (ticket F1, #47).
 *
 * Applied through the local driver (`openCatalog`): on a fresh database, and
 * on top of a v1 database (0001 + 0002 already applied, v1 rows present),
 * where v1 rows must survive and the backfill must fill `search_text`. Also
 * checks the read-time TTL redaction of `comments_active` and
 * `live_chat_messages_active` (ADR-0001, ADR-0009, ADR-0010).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openCatalog, type SqliteExecutor } from './sqlite.ts';

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations');

const FRESH = new Date().toISOString();
const STALE = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();

const COMMENTS_ACTIVE_COLUMNS = [
  'id',
  'video_id',
  'channel_id',
  'author',
  'text',
  'published_at',
  'like_count',
  'has_anchors',
  'fetched_at',
  'expires_at',
  'is_expired',
  'author_channel_id',
  'parent_id',
  'search_text',
];

const LIVE_CHAT_ACTIVE_COLUMNS = [
  'id',
  'video_id',
  'channel_id',
  'author',
  'author_channel_id',
  'text',
  'published_at',
  'offset_seconds',
  'search_text',
  'fetched_at',
  'expires_at',
  'is_expired',
];

async function columns(db: SqliteExecutor, table: string): Promise<string[]> {
  const rows = await db.all<{ name: string }>('SELECT name FROM pragma_table_info(?)', [table]);
  return rows.map((row) => row.name);
}

async function seedChannelAndVideo(db: SqliteExecutor, fetchedAt: string): Promise<void> {
  await db.run(
    'INSERT INTO channels (id, title, uploads_playlist_id, fetched_at) VALUES (?, ?, ?, ?)',
    ['UC1', 'Channel', 'UU1', fetchedAt],
  );
  await db.run(
    `INSERT INTO videos (id, channel_id, title, published_at, thumbnail_url, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ['v1', 'UC1', 'Video', '2024-01-01T00:00:00Z', 'https://i.ytimg.com/x.jpg', fetchedAt],
  );
}

describe('migration 0003_v2_catalog', () => {
  it('applies on a fresh database with every v2 column, table and view', async () => {
    const db = await openCatalog(':memory:');
    try {
      const applied = await db.all<{ name: string }>('SELECT name FROM d1_migrations');
      assert.deepEqual(
        applied.map((row) => row.name),
        ['0001_init.sql', '0002_ingest_requests.sql', '0003_v2_catalog.sql'],
      );
      const videos = await columns(db, 'videos');
      for (const column of [
        'kind',
        'broadcast_state',
        'actual_start_time',
        'actual_end_time',
        'search_text',
      ]) {
        assert.ok(videos.includes(column), `videos.${column}`);
      }
      const comments = await columns(db, 'comments');
      for (const column of ['author_channel_id', 'parent_id', 'search_text']) {
        assert.ok(comments.includes(column), `comments.${column}`);
      }
      const requests = await columns(db, 'ingest_requests');
      for (const column of [
        'key_source',
        'capture_live_chat',
        'replies_written',
        'chat_messages_written',
        'skipped_videos',
        'quota_used',
      ]) {
        assert.ok(requests.includes(column), `ingest_requests.${column}`);
      }
      assert.deepEqual(await columns(db, 'live_chat_messages'), [
        'id',
        'video_id',
        'channel_id',
        'author',
        'author_channel_id',
        'text',
        'published_at',
        'offset_seconds',
        'search_text',
        'fetched_at',
      ]);
      assert.deepEqual(await columns(db, 'comments_active'), COMMENTS_ACTIVE_COLUMNS);
      assert.deepEqual(await columns(db, 'live_chat_messages_active'), LIVE_CHAT_ACTIVE_COLUMNS);
    } finally {
      db.close();
    }
  });

  it('enforces the kind, broadcast_state and key_source CHECKs', async () => {
    const db = await openCatalog(':memory:');
    try {
      await seedChannelAndVideo(db, FRESH);
      await assert.rejects(db.run("UPDATE videos SET kind = 'premiere'"), /CHECK/i);
      await assert.rejects(db.run("UPDATE videos SET broadcast_state = 'upcoming'"), /CHECK/i);
      await db.run("UPDATE videos SET kind = 'broadcast', broadcast_state = 'ended'");
      await assert.rejects(
        db.run(
          `INSERT INTO ingest_requests
             (id, channel_input, channel_key, status, created_at, updated_at, key_source)
           VALUES ('r1', '@x', '@x', 'queued', ?, ?, 'someone')`,
          [FRESH, FRESH],
        ),
        /CHECK/i,
      );
    } finally {
      db.close();
    }
  });

  it('cascades a deleted parent CommentRecord to its Replies', async () => {
    const db = await openCatalog(':memory:');
    try {
      await seedChannelAndVideo(db, FRESH);
      const insert = `INSERT INTO comments
          (id, video_id, channel_id, text, published_at, fetched_at, parent_id)
        VALUES (?, 'v1', 'UC1', ?, '2024-01-02T00:00:00Z', ?, ?)`;
      await db.run(insert, ['c1', 'top', FRESH, null]);
      await db.run(insert, ['c1.r1', 'reply', FRESH, 'c1']);
      await db.run("DELETE FROM comments WHERE id = 'c1'");
      const left = await db.all('SELECT id FROM comments');
      assert.deepEqual(left, []);
    } finally {
      db.close();
    }
  });

  it('upgrades a v1 database: v1 rows survive and search_text is backfilled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ytb-index-0003-'));
    const file = join(dir, 'db.sqlite');
    try {
      // Build a v1 Catalog exactly as production has it: 0001 + 0002 applied
      // and recorded, rows written by a v1 Ingest.
      const v1 = new Database(file);
      v1.exec('CREATE TABLE d1_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
      for (const name of ['0001_init.sql', '0002_ingest_requests.sql']) {
        v1.exec(readFileSync(join(MIGRATIONS_DIR, name), 'utf8'));
        v1.prepare('INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)').run(name, FRESH);
      }
      v1.prepare(
        'INSERT INTO channels (id, title, uploads_playlist_id, fetched_at) VALUES (?, ?, ?, ?)',
      ).run('UC1', 'Channel', 'UU1', FRESH);
      v1.prepare(
        `INSERT INTO videos (id, channel_id, title, description, published_at, thumbnail_url, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('v1', 'UC1', 'My TITLE', 'Some Desc', '2024-01-01T00:00:00Z', 'https://t', FRESH);
      v1.prepare(
        `INSERT INTO comments (id, video_id, channel_id, author, text, published_at, like_count, has_anchors, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('c1', 'v1', 'UC1', 'Ann', 'Great at 5:32 ÁB', '2024-01-02T00:00:00Z', 3, 1, FRESH);
      v1.prepare(
        `INSERT INTO ingest_requests (id, channel_input, channel_key, status, videos_written, comments_written, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('r1', '@x', '@x', 'done', 1, 1, FRESH, FRESH);
      v1.close();

      const db = await openCatalog(file);
      try {
        const video = await db.get('SELECT * FROM videos WHERE id = ?', ['v1']);
        assert.deepEqual(
          {
            title: video?.['title'],
            kind: video?.['kind'],
            broadcast_state: video?.['broadcast_state'],
            actual_start_time: video?.['actual_start_time'],
            search_text: video?.['search_text'],
          },
          {
            title: 'My TITLE',
            kind: 'upload',
            broadcast_state: null,
            actual_start_time: null,
            // ASCII-only lower() backfill (ADR-0010).
            search_text: 'my title some desc',
          },
        );

        const comment = await db.get('SELECT * FROM comments_active WHERE id = ?', ['c1']);
        assert.deepEqual(
          {
            author: comment?.['author'],
            text: comment?.['text'],
            like_count: comment?.['like_count'],
            has_anchors: comment?.['has_anchors'],
            is_expired: comment?.['is_expired'],
            author_channel_id: comment?.['author_channel_id'],
            parent_id: comment?.['parent_id'],
            search_text: comment?.['search_text'],
          },
          {
            author: 'Ann',
            text: 'Great at 5:32 ÁB',
            like_count: 3,
            has_anchors: 1,
            is_expired: 0,
            author_channel_id: '',
            parent_id: null,
            // SQLite lower() leaves non-ASCII as-is; the next Ingest rewrites it.
            search_text: 'great at 5:32 Áb',
          },
        );

        const request = await db.get('SELECT * FROM ingest_requests WHERE id = ?', ['r1']);
        assert.deepEqual(
          {
            status: request?.['status'],
            videos_written: request?.['videos_written'],
            key_source: request?.['key_source'],
            capture_live_chat: request?.['capture_live_chat'],
            replies_written: request?.['replies_written'],
            chat_messages_written: request?.['chat_messages_written'],
            skipped_videos: request?.['skipped_videos'],
            quota_used: request?.['quota_used'],
          },
          {
            status: 'done',
            videos_written: 1,
            key_source: 'repo',
            capture_live_chat: 0,
            replies_written: 0,
            chat_messages_written: 0,
            skipped_videos: 0,
            quota_used: 0,
          },
        );
        assert.deepEqual(await columns(db, 'comments_active'), COMMENTS_ACTIVE_COLUMNS);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('redacts text and search_text of expired rows in both _active views', async () => {
    const db = await openCatalog(':memory:');
    try {
      await seedChannelAndVideo(db, FRESH);
      const comment = `INSERT INTO comments
          (id, video_id, channel_id, text, search_text, published_at, fetched_at)
        VALUES (?, 'v1', 'UC1', ?, ?, '2024-01-02T00:00:00Z', ?)`;
      await db.run(comment, ['fresh', 'Fresh text', 'fresh text', FRESH]);
      await db.run(comment, ['stale', 'Stale text', 'stale text', STALE]);
      const chat = `INSERT INTO live_chat_messages
          (id, video_id, channel_id, author, author_channel_id, text, published_at,
           offset_seconds, search_text, fetched_at)
        VALUES (?, 'v1', 'UC1', 'Bo', 'UC2', ?, '2024-01-02T00:00:10Z', 10, ?, ?)`;
      await db.run(chat, ['m-fresh', 'Hi there', 'hi there', FRESH]);
      await db.run(chat, ['m-stale', 'Old one', 'old one', STALE]);

      const comments = await db.all(
        'SELECT id, text, search_text, is_expired FROM comments_active ORDER BY id',
      );
      assert.deepEqual(comments, [
        { id: 'fresh', text: 'Fresh text', search_text: 'fresh text', is_expired: 0 },
        {
          id: 'stale',
          text: '[Comment text expired — refresh to recover]',
          search_text: '',
          is_expired: 1,
        },
      ]);

      const messages = await db.all(
        `SELECT id, text, search_text, offset_seconds, is_expired
           FROM live_chat_messages_active ORDER BY id`,
      );
      assert.deepEqual(messages, [
        {
          id: 'm-fresh',
          text: 'Hi there',
          search_text: 'hi there',
          offset_seconds: 10,
          is_expired: 0,
        },
        {
          id: 'm-stale',
          text: '[Message text expired — refresh to recover]',
          search_text: '',
          offset_seconds: 10,
          is_expired: 1,
        },
      ]);
    } finally {
      db.close();
    }
  });
});
