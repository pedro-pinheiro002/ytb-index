/**
 * Tests for the portable filter builder (`./filter.ts`), R2 (#46) / ADR-0010.
 *
 * Every built query runs twice against the same seeded `:memory:` Catalog:
 * once on the local better-sqlite3 executor, and once through
 * `createD1Executor` over a `D1Binding` test double that records each bound
 * statement and answers it from that SQLite database. Both must return the
 * same rows, so the SQL and its positional params are portable.
 *
 * Run via `pnpm test` (node:test runner).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Channel, VideoRecord } from '../shared/types.ts';
import { createD1Executor } from './d1.ts';
import type { Executor } from './executor.ts';
import { buildQuery, escapeLike, type BuiltQuery, type QueryOptions } from './filter.ts';
import { upsertChannel, upsertVideos } from './ingest-writes.ts';
import { SqliteBackedBinding } from './sqlite-backed-d1.ts';
import { openCatalog, type SqliteExecutor } from './sqlite.ts';

const CHANNEL: Channel = {
  id: 'UC_filter',
  title: 'Filter Channel',
  uploadsPlaylistId: 'UU_filter',
  fetchedAt: '2026-01-01T00:00:00.000Z',
};

const OTHER: Channel = { ...CHANNEL, id: 'UC_other', uploadsPlaylistId: 'UU_other' };

function video(
  id: string,
  title: string,
  publishedAt: string,
  channelId = CHANNEL.id,
): VideoRecord {
  return {
    id,
    channelId,
    title,
    description: '',
    publishedAt,
    thumbnailUrl: `https://example.com/${id}.jpg`,
    durationIso8601: 'PT1M',
    viewCount: 0,
    likeCount: 0,
    commentCount: 0,
    fetchedAt: CHANNEL.fetchedAt,
  };
}

const VIDEOS: VideoRecord[] = [
  video('v1', '100% legit', '2024-01-01T00:00:00.000Z'),
  video('v2', '100 percent', '2024-02-01T00:00:00.000Z'),
  video('v3', 'a_b', '2024-03-01T00:00:00.000Z'),
  video('v4', 'axb', '2024-04-01T00:00:00.000Z'),
  video('v5', 'back\\slash', '2024-05-01T00:00:00.000Z', OTHER.id),
];

const SELECT = 'SELECT id FROM videos';
const ORDERINGS = { newest: 'published_at DESC, id DESC', oldest: 'published_at ASC, id ASC' };

let sqlite: SqliteExecutor;
let binding: SqliteBackedBinding;
let d1: Executor;

before(async () => {
  sqlite = await openCatalog(':memory:');
  await upsertChannel(sqlite, CHANNEL);
  await upsertChannel(sqlite, OTHER);
  await upsertVideos(sqlite, VIDEOS);
  binding = new SqliteBackedBinding(sqlite);
  d1 = createD1Executor(binding);
});

after(() => sqlite.close());

/** Run `query` on both executors, assert they agree, and return the ids. */
async function ids(query: BuiltQuery): Promise<string[]> {
  const local = await sqlite.all<{ id: string }>(query.sql, query.params);
  const remote = await d1.all<{ id: string }>(query.sql, query.params);
  assert.deepEqual(remote, local, 'D1 and SQLite disagree');
  assert.deepEqual(binding.bound.at(-1), { sql: query.sql, params: query.params });
  return local.map((row) => row.id).sort();
}

function build(options: QueryOptions<keyof typeof ORDERINGS>): BuiltQuery {
  return buildQuery(SELECT, options);
}

describe('buildQuery', () => {
  it('an empty filter adds no WHERE and no params', async () => {
    const query = buildQuery(SELECT);
    assert.deepEqual(query, { sql: SELECT, params: [] });
    assert.deepEqual(build({ where: [] }), { sql: SELECT, params: [] });
    assert.deepEqual(await ids(query), ['v1', 'v2', 'v3', 'v4', 'v5']);
  });

  it('ANDs predicates with positional params in order', async () => {
    const query = build({
      where: [
        { op: 'eq', column: 'channel_id', value: CHANNEL.id },
        { op: 'gte', column: 'published_at', value: '2024-02-01' },
        { op: 'lte', column: 'published_at', value: '2024-03-31' },
      ],
    });
    assert.equal(
      query.sql,
      `${SELECT} WHERE channel_id = ? AND published_at >= ? AND published_at <= ?`,
    );
    assert.deepEqual(query.params, [CHANNEL.id, '2024-02-01', '2024-03-31']);
    assert.deepEqual(await ids(query), ['v2', 'v3']);
  });

  it('compiles IN lists, and an empty IN list matches nothing', async () => {
    const query = build({ where: [{ op: 'in', column: 'id', values: ['v1', 'v5'] }] });
    assert.equal(query.sql, `${SELECT} WHERE id IN (?, ?)`);
    assert.deepEqual(await ids(query), ['v1', 'v5']);
    assert.deepEqual(await ids(build({ where: [{ op: 'in', column: 'id', values: [] }] })), []);
  });

  it('contains escapes LIKE metacharacters so they match literally', async () => {
    const percent = build({ where: [{ op: 'contains', column: 'title', value: '100%' }] });
    assert.equal(percent.sql, `${SELECT} WHERE title LIKE '%' || ? || '%' ESCAPE '\\'`);
    assert.deepEqual(percent.params, ['100\\%']);
    assert.deepEqual(await ids(percent), ['v1']);

    const underscore = build({ where: [{ op: 'contains', column: 'title', value: 'a_b' }] });
    assert.deepEqual(await ids(underscore), ['v3']);

    const backslash = build({ where: [{ op: 'contains', column: 'title', value: '\\' }] });
    assert.deepEqual(await ids(backslash), ['v5']);
  });

  it('orders from the whitelist and binds LIMIT / OFFSET as params', async () => {
    const query = build({ order: { by: 'newest', orderings: ORDERINGS }, limit: 2, offset: 1 });
    assert.equal(query.sql, `${SELECT} ORDER BY published_at DESC, id DESC LIMIT ? OFFSET ?`);
    assert.deepEqual(query.params, [2, 1]);
    const rows = await sqlite.all<{ id: string }>(query.sql, query.params);
    assert.deepEqual(
      rows.map((row) => row.id),
      ['v4', 'v3'],
    );
    assert.deepEqual(await ids(query), ['v3', 'v4']);
  });

  it('puts WHERE params before pagination params', async () => {
    const query = build({
      where: [{ op: 'eq', column: 'channel_id', value: CHANNEL.id }],
      order: { by: 'oldest', orderings: ORDERINGS },
      limit: 1,
      offset: 3,
    });
    assert.deepEqual(query.params, [CHANNEL.id, 1, 3]);
    assert.deepEqual(await ids(query), ['v4']);
  });

  it('an offset without a limit emits LIMIT -1', async () => {
    const query = build({ order: { by: 'oldest', orderings: ORDERINGS }, offset: 4 });
    assert.equal(query.sql, `${SELECT} ORDER BY published_at ASC, id ASC LIMIT -1 OFFSET ?`);
    assert.deepEqual(query.params, [4]);
    assert.deepEqual(await ids(query), ['v5']);
  });

  it('rejects non-whitelisted orderings, bad columns and bad page params', () => {
    assert.throws(
      () =>
        buildQuery<string>(SELECT, {
          order: { by: 'likes', orderings: ORDERINGS as Record<string, string> },
        }),
      TypeError,
    );
    assert.throws(
      () => build({ where: [{ op: 'eq', column: 'id; DROP TABLE videos', value: 1 }] }),
      TypeError,
    );
    assert.throws(() => build({ limit: -1 }), RangeError);
    assert.throws(() => build({ offset: 1.5 }), RangeError);
  });
});

describe('escapeLike', () => {
  it('prefixes \\, % and _ with a backslash and leaves the rest alone', () => {
    assert.equal(escapeLike('plain text'), 'plain text');
    assert.equal(escapeLike('50%_off\\now'), '50\\%\\_off\\\\now');
  });
});

describe('buildQuery: lt, isNull / notNull, inJson (F4 #50)', () => {
  it('lt is a strict upper bound', async () => {
    const query = build({ where: [{ op: 'lt', column: 'published_at', value: '2024-02-01' }] });
    assert.equal(query.sql, `${SELECT} WHERE published_at < ?`);
    assert.deepEqual(await ids(query), ['v1']);
  });

  it('isNull / notNull bind no params', async () => {
    const isNull = build({ where: [{ op: 'isNull', column: 'actual_start_time' }] });
    assert.deepEqual(isNull, { sql: `${SELECT} WHERE actual_start_time IS NULL`, params: [] });
    assert.deepEqual(await ids(isNull), ['v1', 'v2', 'v3', 'v4', 'v5']);
    const notNull = build({ where: [{ op: 'notNull', column: 'actual_start_time' }] });
    assert.equal(notNull.sql, `${SELECT} WHERE actual_start_time IS NOT NULL`);
    assert.deepEqual(await ids(notNull), []);
  });

  it('inJson binds the whole list as one JSON param; empty matches nothing', async () => {
    const query = build({ where: [{ op: 'inJson', column: 'title', values: ['a_b', 'axb'] }] });
    assert.equal(query.sql, `${SELECT} WHERE title IN (SELECT value FROM json_each(?))`);
    assert.deepEqual(query.params, ['["a_b","axb"]']);
    assert.deepEqual(await ids(query), ['v3', 'v4']);
    assert.deepEqual(await ids(build({ where: [{ op: 'inJson', column: 'id', values: [] }] })), []);
  });
});
