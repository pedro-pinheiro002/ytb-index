/**
 * Tests for the ADR-0012 measurement helpers (`scripts/measure/`): the
 * sample-vs-full comparison and the D1 rows-written tally, through a fake
 * binding. Run with `pnpm exec tsx --test scripts/measure/compare.test.ts`
 * (outside `pnpm test`, whose glob covers `src/` only).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compareSamples, type CommentSide } from './compare.ts';
import { measureRowsWritten, tableOf } from './rows-written.ts';
import type { CommentRecord, TimeAnchor } from '../../src/shared/types.ts';

function comment(id: string, videoId: string): CommentRecord {
  return {
    id,
    videoId,
    channelId: 'UC1',
    author: 'a',
    authorChannelId: '',
    parentId: null,
    text: '',
    searchText: '',
    publishedAt: '2026-10-01T00:00:00Z',
    likeCount: 0,
    hasAnchors: 0,
    fetchedAt: '2026-11-01T00:00:00Z',
  };
}

function anchor(commentId: string, seconds: number): TimeAnchor {
  return { commentId, seconds, rawText: '', charPosition: 0 };
}

function side(comments: CommentRecord[], anchors: TimeAnchor[]): CommentSide {
  return { comments, anchors };
}

describe('compareSamples', () => {
  const full = side(
    [comment('c1', 'v1'), comment('c2', 'v1'), comment('c3', 'v1'), comment('c4', 'v2')],
    [anchor('c1', 60), anchor('c2', 60), anchor('c3', 300), anchor('c4', 10)],
  );

  it('counts recall and Key moments per VideoRecord', () => {
    const sample = side([comment('c1', 'v1'), comment('c3', 'v1')], [anchor('c1', 60)]);
    const report = compareSamples(['v1', 'v2'], full, sample);
    const v1 = report.perVideo[0];
    assert.ok(v1 !== undefined);
    assert.equal(v1.fullTimestamped, 3);
    assert.equal(v1.sampleTimestamped, 1);
    assert.equal(v1.timestampedRecall, 1 / 3);
    assert.deepEqual(v1.fullKeyMoments, [60, 300]);
    assert.deepEqual(v1.sampleKeyMoments, [60]);
    assert.equal(v1.keyMomentsExact, 0.5);
    assert.equal(v1.topMomentMatch, true);
  });

  it('pools recall and lists VideoRecords whose anchors the sample missed', () => {
    const sample = side([comment('c1', 'v1')], [anchor('c1', 60)]);
    const { summary } = compareSamples(['v1', 'v2'], full, sample);
    assert.equal(summary.fullTimestamped, 4);
    assert.equal(summary.timestampedRecall, 1 / 4);
    assert.equal(summary.topMomentMatchRate, 0.5);
    assert.deepEqual(summary.videosMissingAllAnchors, ['v2']);
  });

  it('counts a nearby second as found within the tolerance only', () => {
    const sample = side([comment('x', 'v1')], [anchor('x', 305), anchor('x', 64)]);
    const v1 = compareSamples(['v1'], full, sample, { toleranceSeconds: 5 }).perVideo[0];
    assert.equal(v1?.keyMomentsExact, 0);
    assert.equal(v1?.keyMomentsTolerant, 1);
  });

  it('reports null ratios for a VideoRecord without comments', () => {
    const v3 = compareSamples(['v3'], full, side([], [])).perVideo[0];
    assert.equal(v3?.timestampedRecall, null);
    assert.equal(v3?.topMomentMatch, null);
  });
});

describe('measureRowsWritten', () => {
  it('names the table of an upsert', () => {
    assert.equal(tableOf('\n  INSERT INTO comments (id) VALUES (?)'), 'comments');
    assert.equal(tableOf('UPDATE x SET y = 1'), 'other');
  });

  it('sums meta.rows_written per table across batches and binds undefined as NULL', async () => {
    const bound: unknown[][] = [];
    const binding = {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => {
          bound.push(values);
          return sql;
        },
      }),
      batch: async (statements: unknown[]) =>
        statements.map((sql) => ({
          meta: { rows_written: String(sql).includes('comments') ? 6 : 2 },
        })),
    };
    const tally = await measureRowsWritten(
      binding,
      [
        { sql: 'INSERT INTO comments VALUES (?)', params: [undefined] },
        { sql: 'INSERT INTO comments VALUES (?)', params: ['b'] },
        { sql: 'INSERT INTO time_anchors VALUES (?)', params: ['c'] },
      ],
      2,
    );
    assert.deepEqual(tally, {
      comments: { statements: 2, rowsWritten: 12 },
      time_anchors: { statements: 1, rowsWritten: 2 },
    });
    assert.deepEqual(bound[0], [null]);
  });
});
