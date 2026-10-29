/**
 * Tests for the reads R2 (#46) moved into `./catalog-reads.ts` from the
 * server routes: `getVideo`, `listVideoAnchors`, `timestampedCounts`,
 * `getChannel` and `getLatestChannel`, on a seeded `:memory:` Catalog. F7
 * (#54) adds the video page's v2 reads: Broadcast fields on `getVideo`,
 * Reply fields on `listVideoComments`, and `listVideoChatMessages`, the
 * latter also through `createD1Executor` over the SQLite-backed D1 double.
 *
 * Run via `pnpm test` (node:test runner).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Channel, CommentRecord, TimeAnchor, VideoRecord } from '../shared/types.ts';
import {
  getChannel,
  getLatestChannel,
  getVideo,
  listVideoAnchors,
  listVideoChatMessages,
  listVideoComments,
  timestampedCounts,
} from './catalog-reads.ts';
import { createD1Executor } from './d1.ts';
import { ingestStatements } from './ingest-writes.ts';
import { SqliteBackedBinding } from './sqlite-backed-d1.ts';
import { openCatalog, type SqliteExecutor } from './sqlite.ts';

const OLD: Channel = {
  id: 'UC_old',
  title: 'Old Channel',
  uploadsPlaylistId: 'UU_old',
  fetchedAt: '2026-01-01T00:00:00.000Z',
};
const NEW: Channel = {
  ...OLD,
  id: 'UC_new',
  title: 'New Channel',
  fetchedAt: '2026-02-01T00:00:00.000Z',
};

const VIDEO: VideoRecord = {
  id: 'v1',
  channelId: OLD.id,
  title: 'Video one',
  description: 'desc',
  publishedAt: '2025-01-01T00:00:00.000Z',
  thumbnailUrl: 'https://example.com/v1.jpg',
  durationIso8601: 'PT1M',
  viewCount: 5,
  likeCount: 1,
  commentCount: 2,
  fetchedAt: OLD.fetchedAt,
};

function comment(id: string, hasAnchors: 0 | 1): CommentRecord {
  return {
    id,
    videoId: VIDEO.id,
    channelId: OLD.id,
    author: 'A',
    text: `text ${id}`,
    publishedAt: '2025-01-02T00:00:00.000Z',
    likeCount: 0,
    hasAnchors,
    fetchedAt: OLD.fetchedAt,
  };
}

const ANCHORS: TimeAnchor[] = [
  { commentId: 'c1', seconds: 90, rawText: '1:30', charPosition: 10 },
  { commentId: 'c1', seconds: 5, rawText: '0:05', charPosition: 2 },
];

let db: SqliteExecutor;

before(async () => {
  db = await openCatalog(':memory:');
  await db.batch(
    ingestStatements({
      channel: OLD,
      videos: [VIDEO],
      comments: [comment('c1', 1), comment('c2', 0)],
      anchors: ANCHORS,
    }),
  );
  await db.batch(ingestStatements({ channel: NEW, videos: [], comments: [], anchors: [] }));
});

after(() => db.close());

describe('catalog reads', () => {
  it('getVideo returns the VideoRecord by id, or undefined', async () => {
    assert.deepEqual(await getVideo(db, 'v1'), {
      ...VIDEO,
      kind: 'upload',
      broadcastState: null,
      actualStartTime: null,
      actualEndTime: null,
    });
    assert.equal(await getVideo(db, 'missing'), undefined);
  });

  it('listVideoAnchors returns the anchors ordered by char_position', async () => {
    assert.deepEqual(await listVideoAnchors(db, 'v1'), [ANCHORS[1], ANCHORS[0]]);
    assert.deepEqual(await listVideoAnchors(db, 'missing'), []);
  });

  it('timestampedCounts counts comments holding an anchor per video', async () => {
    assert.deepEqual(await timestampedCounts(db), new Map([['v1', 1]]));
  });

  it('getChannel / getLatestChannel read Channels', async () => {
    assert.deepEqual(await getChannel(db, OLD.id), OLD);
    assert.equal(await getChannel(db, 'UC_missing'), undefined);
    assert.deepEqual(await getLatestChannel(db), NEW);
  });
});

describe('catalog reads: Broadcasts, Replies and LiveChatMessages (F7 #54)', () => {
  const DAY_MS = 86_400_000;
  const FRESH = new Date(Date.now() - DAY_MS).toISOString();
  const EXPIRED = new Date(Date.now() - 31 * DAY_MS).toISOString();
  let v2: SqliteExecutor;

  async function chat(
    id: string,
    offset: number,
    publishedAt: string,
    fetchedAt = FRESH,
  ): Promise<void> {
    await v2.run(
      `INSERT INTO live_chat_messages (id, video_id, channel_id, author, author_channel_id, text,
         published_at, offset_seconds, fetched_at) VALUES (?, 'b1', 'UC_b', ?, ?, ?, ?, ?, ?)`,
      [id, `Author ${id}`, `UC_author_${id}`, `text ${id}`, publishedAt, offset, fetchedAt],
    );
  }

  before(async () => {
    v2 = await openCatalog(':memory:');
    await v2.run(
      'INSERT INTO channels (id, title, uploads_playlist_id, fetched_at) VALUES (?, ?, ?, ?)',
      ['UC_b', 'B', 'UU_b', FRESH],
    );
    await v2.run(
      `INSERT INTO videos (id, channel_id, title, description, published_at, thumbnail_url,
         duration_iso8601, fetched_at, kind, broadcast_state, actual_start_time, actual_end_time)
       VALUES ('b1', 'UC_b', 'Stream', '', '2026-01-01T10:00:00Z', '', 'P0D', ?, 'broadcast',
         'ended', '2026-01-01T10:00:05Z', '2026-01-01T11:30:05Z')`,
      [FRESH],
    );
    for (const [id, parent] of [
      ['top', null],
      ['reply', 'top'],
    ] as const) {
      await v2.run(
        `INSERT INTO comments (id, video_id, channel_id, author, text, published_at, like_count,
           has_anchors, fetched_at, author_channel_id, parent_id)
         VALUES (?, 'b1', 'UC_b', 'A', 'hi', '2026-01-02T00:00:00Z', 0, 0, ?, ?, ?)`,
        [id, FRESH, `UC_${id}`, parent],
      );
    }
    // Inserted out of order: offset, then published_at, then id decide.
    await chat('m3', 20, '2026-01-01T10:00:25Z');
    await chat('m2b', 5, '2026-01-01T10:00:10Z');
    await chat('m2a', 5, '2026-01-01T10:00:10Z');
    await chat('m1', 5, '2026-01-01T10:00:09Z');
    await chat('old', 30, '2026-01-01T10:00:35Z', EXPIRED);
  });

  after(() => v2.close());

  it('getVideo maps the Broadcast fields', async () => {
    const video = await getVideo(v2, 'b1');
    assert.equal(video?.kind, 'broadcast');
    assert.equal(video?.broadcastState, 'ended');
    assert.equal(video?.actualStartTime, '2026-01-01T10:00:05Z');
    assert.equal(video?.actualEndTime, '2026-01-01T11:30:05Z');
  });

  it('listVideoComments maps parentId and authorChannelId', async () => {
    const comments = await listVideoComments(v2, 'b1');
    const byId = new Map(comments.map((c) => [c.id, c]));
    assert.equal(byId.get('top')?.parentId, null);
    assert.equal(byId.get('reply')?.parentId, 'top');
    assert.equal(byId.get('reply')?.authorChannelId, 'UC_reply');
  });

  it('listVideoChatMessages orders by offset, then published_at, then id, redacting expired text', async () => {
    const messages = await listVideoChatMessages(v2, 'b1');
    assert.deepEqual(
      messages.map((m) => m.id),
      ['m1', 'm2a', 'm2b', 'm3', 'old'],
    );
    assert.deepEqual(messages[0], {
      id: 'm1',
      videoId: 'b1',
      channelId: 'UC_b',
      author: 'Author m1',
      authorChannelId: 'UC_author_m1',
      text: 'text m1',
      publishedAt: '2026-01-01T10:00:09Z',
      offsetSeconds: 5,
      fetchedAt: FRESH,
      expiresAt: messages[0]?.expiresAt,
      isExpired: false,
    });
    assert.equal(typeof messages[0]?.expiresAt, 'string');
    const old = messages.at(-1);
    assert.equal(old?.isExpired, true);
    assert.equal(old?.text, '[Message text expired — refresh to recover]');
    assert.deepEqual(await listVideoChatMessages(v2, 'missing'), []);
  });

  it('listVideoChatMessages returns the same rows through createD1Executor', async () => {
    const binding = new SqliteBackedBinding(v2);
    const d1 = createD1Executor(binding);
    assert.deepEqual(await listVideoChatMessages(d1, 'b1'), await listVideoChatMessages(v2, 'b1'));
    assert.deepEqual(binding.bound.at(-1)?.params, ['b1']);
  });
});
