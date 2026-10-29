/**
 * Tests for the reads R2 (#46) moved into `./catalog-reads.ts` from the
 * server routes: `getVideo`, `listVideoAnchors`, `timestampedCounts`,
 * `getChannel` and `getLatestChannel`, on a seeded `:memory:` Catalog.
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
  timestampedCounts,
} from './catalog-reads.ts';
import { ingestStatements } from './ingest-writes.ts';
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
    assert.deepEqual(await getVideo(db, 'v1'), VIDEO);
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
