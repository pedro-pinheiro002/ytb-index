/**
 * Tests for Catalog search (`./catalog-search.ts`), F4 (#50) / ADR-0010.
 *
 * A seeded `:memory:` Catalog (rows inserted with `search_text` written by
 * `normalizeSearchText`, as Ingest does) answers every SearchQuery twice:
 * on the local better-sqlite3 executor and through `createD1Executor` over
 * the SQLite-backed D1 double. Both must return the same page, so the SQL is
 * portable. A clock-shifted fixture (fetched 31 days ago) proves expired
 * CommentRecords, Replies and LiveChatMessages never match or appear
 * (ADR-0001).
 *
 * Run via `pnpm test` (node:test runner).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SearchQuery } from '../shared/types.ts';
import {
  isEmptySearch,
  parseSearchQuery,
  searchCatalog,
  type SearchPage,
} from './catalog-search.ts';
import { createD1Executor } from './d1.ts';
import type { Executor } from './executor.ts';
import { normalizeSearchText } from './search-text.ts';
import { SqliteBackedBinding } from './sqlite-backed-d1.ts';
import { openCatalog, type SqliteExecutor } from './sqlite.ts';

const CH_A = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const CH_B = 'UCbbbbbbbbbbbbbbbbbbbbbb';
const JOAO = 'UCjoaojoaojoaojoaojoao12';
const CHATTER = 'UCchatchatchatchatchat12';

const DAY_MS = 86_400_000;
const FRESH = new Date(Date.now() - DAY_MS).toISOString();
const EXPIRED = new Date(Date.now() - 31 * DAY_MS).toISOString();

let sqlite: SqliteExecutor;
let d1: Executor;
let binding: SqliteBackedBinding;

async function seedVideo(
  id: string,
  channelId: string,
  title: string,
  publishedAt: string,
  description = '',
): Promise<void> {
  await sqlite.run(
    `INSERT INTO videos (id, channel_id, title, description, published_at, thumbnail_url,
       fetched_at, search_text) VALUES (?, ?, ?, ?, ?, '', ?, ?)`,
    [
      id,
      channelId,
      title,
      description,
      publishedAt,
      FRESH,
      normalizeSearchText(`${title} ${description}`),
    ],
  );
}

interface CommentSeed {
  id: string;
  videoId: string;
  channelId?: string;
  author: string;
  authorChannelId?: string;
  text: string;
  publishedAt: string;
  likeCount?: number;
  parentId?: string;
  anchors?: Array<{ seconds: number; charPosition: number }>;
  fetchedAt?: string;
}

async function seedComment(seed: CommentSeed): Promise<void> {
  const anchors = seed.anchors ?? [];
  await sqlite.run(
    `INSERT INTO comments (id, video_id, channel_id, author, text, published_at, like_count,
       has_anchors, fetched_at, author_channel_id, parent_id, search_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      seed.id,
      seed.videoId,
      seed.channelId ?? CH_A,
      seed.author,
      seed.text,
      seed.publishedAt,
      seed.likeCount ?? 0,
      anchors.length > 0 ? 1 : 0,
      seed.fetchedAt ?? FRESH,
      seed.authorChannelId ?? '',
      seed.parentId ?? null,
      normalizeSearchText(seed.text),
    ],
  );
  for (const anchor of anchors) {
    await sqlite.run(
      'INSERT INTO time_anchors (comment_id, seconds, raw_text, char_position) VALUES (?, ?, ?, ?)',
      [seed.id, anchor.seconds, String(anchor.seconds), anchor.charPosition],
    );
  }
}

async function seedChat(
  id: string,
  author: string,
  authorChannelId: string,
  text: string,
  publishedAt: string,
  offsetSeconds: number,
  fetchedAt = FRESH,
): Promise<void> {
  await sqlite.run(
    `INSERT INTO live_chat_messages (id, video_id, channel_id, author, author_channel_id, text,
       published_at, offset_seconds, search_text, fetched_at)
     VALUES (?, 'vA2', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      CH_A,
      author,
      authorChannelId,
      text,
      publishedAt,
      offsetSeconds,
      normalizeSearchText(text),
      fetchedAt,
    ],
  );
}

before(async () => {
  sqlite = await openCatalog(':memory:');
  for (const id of [CH_A, CH_B]) {
    await sqlite.run(
      'INSERT INTO channels (id, title, uploads_playlist_id, fetched_at) VALUES (?, ?, ?, ?)',
      [id, id, `UU${id.slice(2)}`, FRESH],
    );
  }
  await seedVideo('vA1', CH_A, 'Ação no parque', '2024-01-10T15:00:00Z', 'Um passeio');
  await seedVideo('vA2', CH_A, 'Broadcast ao vivo', '2024-03-05T11:00:00Z');
  await seedVideo('vB1', CH_B, 'Other channel acao', '2024-02-01T00:00:00Z');

  await seedComment({
    id: 'c1',
    videoId: 'vA1',
    author: 'João Silva',
    authorChannelId: JOAO,
    text: 'Que ação incrível 1:23 e 0:05',
    publishedAt: '2024-01-11T10:00:00Z',
    likeCount: 5,
    // Inserted out of text order: the read must sort by char_position.
    anchors: [
      { seconds: 5, charPosition: 25 },
      { seconds: 83, charPosition: 18 },
    ],
  });
  await seedComment({
    id: 'c2',
    videoId: 'vA1',
    author: 'maria',
    text: 'ACAO boa',
    publishedAt: '2024-01-12T23:59:59Z',
    likeCount: 10,
  });
  await seedComment({
    id: 'r1',
    videoId: 'vA1',
    author: 'Pedro',
    text: 'Concordo, ação!',
    publishedAt: '2024-01-13T08:00:00Z',
    likeCount: 1,
    parentId: 'c1',
  });
  await seedComment({
    id: 'c3',
    videoId: 'vB1',
    channelId: CH_B,
    author: 'JOÃO silva',
    authorChannelId: JOAO,
    text: '100% acao',
    publishedAt: '2024-02-02T00:00:00Z',
  });
  await seedComment({
    id: 'c4',
    videoId: 'vA2',
    author: 'x',
    text: 'a_b literal',
    publishedAt: '2024-03-06T00:00:00Z',
  });
  await seedComment({
    id: 'c5',
    videoId: 'vA2',
    author: 'x',
    text: 'axb literal',
    publishedAt: '2024-03-07T00:00:00Z',
  });
  // Clock-shifted: fetched 31 days ago, so the *_active views expire them.
  await seedComment({
    id: 'cExp',
    videoId: 'vA1',
    author: 'Ghost',
    authorChannelId: 'UCghostghostghostghost123',
    text: 'acao expired 2:00',
    publishedAt: '2024-01-15T00:00:00Z',
    likeCount: 99,
    anchors: [{ seconds: 120, charPosition: 13 }],
    fetchedAt: EXPIRED,
  });
  await seedComment({
    id: 'rExp',
    videoId: 'vA1',
    author: 'Ghost',
    text: 'acao reply expired',
    publishedAt: '2024-01-16T00:00:00Z',
    parentId: 'c2',
    fetchedAt: EXPIRED,
  });
  await seedChat('m1', 'Chatter', CHATTER, 'AÇÃO ao vivo!', '2024-03-05T12:00:00Z', 3600);
  await seedChat('mExp', 'Ghost', '', 'acao chat expired', '2024-03-05T12:01:00Z', 3660, EXPIRED);

  // Bulk rows for pagination: 50 top-level comments on vB1.
  for (let i = 0; i < 50; i += 1) {
    await seedComment({
      id: `bulk${String(i).padStart(2, '0')}`,
      videoId: 'vB1',
      channelId: CH_B,
      author: 'Bulk',
      text: `paginate me ${i}`,
      publishedAt: new Date(Date.UTC(2024, 5, 1) + i * 60_000).toISOString(),
    });
  }

  binding = new SqliteBackedBinding(sqlite);
  d1 = createD1Executor(binding);
});

after(() => sqlite.close());

function query(overrides: Partial<SearchQuery> = {}): SearchQuery {
  return {
    terms: [],
    kinds: ['comment', 'reply', 'chat'],
    channelId: null,
    from: null,
    to: null,
    videoFrom: null,
    videoTo: null,
    author: null,
    timestamped: false,
    sort: 'newest',
    page: 1,
    ...overrides,
  };
}

/** Run on SQLite and through the D1 double; assert both agree. */
async function search(overrides: Partial<SearchQuery>): Promise<SearchPage> {
  const local = await searchCatalog(sqlite, query(overrides));
  const remote = await searchCatalog(d1, query(overrides));
  assert.deepEqual(remote, local, 'D1 and SQLite disagree');
  return local;
}

async function ids(overrides: Partial<SearchQuery>): Promise<string[]> {
  return (await search(overrides)).hits.map((hit) => hit.recordId);
}

describe('searchCatalog: terms', () => {
  it('folds accents and case through search_text ("acao" finds "Ação")', async () => {
    assert.deepEqual(await ids({ terms: ['acao'] }), ['m1', 'c3', 'r1', 'c2', 'c1']);
  });

  it('normalizes hand-built terms too', async () => {
    assert.deepEqual(await ids({ terms: ['AÇÃO'] }), ['m1', 'c3', 'r1', 'c2', 'c1']);
  });

  it('ANDs terms', async () => {
    assert.deepEqual(await ids({ terms: ['acao', 'boa'] }), ['c2']);
    assert.deepEqual(await ids({ terms: ['acao', 'nothing'] }), []);
  });

  it('never lets LIKE metacharacters act as wildcards', async () => {
    // `_` would match the "x" in "axb" as a wildcard; normalized it is a space.
    assert.deepEqual(await ids({ terms: ['a_b'] }), ['c4']);
    // A term that folds to '' is no filter: alone it is an empty search, not
    // the whole Catalog; beside another term it adds nothing.
    assert.deepEqual(await ids({ terms: ['%'] }), []);
    assert.deepEqual(await ids({ terms: ['%_', 'boa'] }), ['c2']);
  });
});

describe('searchCatalog: kinds', () => {
  it('defaults to comment, reply, chat (no videos)', async () => {
    const page = await search({ terms: ['acao'] });
    assert.deepEqual([...new Set(page.hits.map((hit) => hit.kind))].sort(), [
      'chat',
      'comment',
      'reply',
    ]);
  });

  it('each kind alone, and video over title + description', async () => {
    assert.deepEqual(await ids({ terms: ['acao'], kinds: ['comment'] }), ['c3', 'c2', 'c1']);
    assert.deepEqual(await ids({ terms: ['acao'], kinds: ['reply'] }), ['r1']);
    assert.deepEqual(await ids({ terms: ['acao'], kinds: ['chat'] }), ['m1']);
    assert.deepEqual(await ids({ terms: ['acao'], kinds: ['video'] }), ['vB1', 'vA1']);
    assert.deepEqual(await ids({ terms: ['passeio'], kinds: ['video'] }), ['vA1']);
  });

  it('merges explicit kinds into one ordered page', async () => {
    assert.deepEqual(await ids({ terms: ['acao'], kinds: ['video', 'chat'] }), [
      'm1',
      'vB1',
      'vA1',
    ]);
  });
});

describe('searchCatalog: SearchHit shape', () => {
  it('fills comment, reply, chat and video hits', async () => {
    const page = await search({ terms: ['acao'], kinds: ['comment', 'reply', 'chat', 'video'] });
    const byId = new Map(page.hits.map((hit) => [hit.recordId, hit]));
    assert.deepEqual(byId.get('c1'), {
      kind: 'comment',
      videoId: 'vA1',
      videoTitle: 'Ação no parque',
      recordId: 'c1',
      author: 'João Silva',
      authorChannelId: JOAO,
      publishedAt: '2024-01-11T10:00:00Z',
      text: 'Que ação incrível 1:23 e 0:05',
      likeCount: 5,
      anchorSeconds: [83, 5],
      offsetSeconds: null,
      parentId: null,
      parentAuthor: null,
    });
    assert.deepEqual(byId.get('r1')?.parentId, 'c1');
    assert.deepEqual(byId.get('r1')?.parentAuthor, 'João Silva');
    assert.deepEqual(byId.get('r1')?.anchorSeconds, []);
    assert.deepEqual(byId.get('m1'), {
      kind: 'chat',
      videoId: 'vA2',
      videoTitle: 'Broadcast ao vivo',
      recordId: 'm1',
      author: 'Chatter',
      authorChannelId: CHATTER,
      publishedAt: '2024-03-05T12:00:00Z',
      text: 'AÇÃO ao vivo!',
      likeCount: 0,
      anchorSeconds: [],
      offsetSeconds: 3600,
      parentId: null,
      parentAuthor: null,
    });
    assert.deepEqual(byId.get('vA1'), {
      kind: 'video',
      videoId: 'vA1',
      videoTitle: 'Ação no parque',
      recordId: 'vA1',
      author: '',
      authorChannelId: '',
      publishedAt: '2024-01-10T15:00:00Z',
      text: 'Ação no parque',
      likeCount: 0,
      anchorSeconds: [],
      offsetSeconds: null,
      parentId: null,
      parentAuthor: null,
    });
  });
});

describe('searchCatalog: filters', () => {
  it('scopes to one Channel', async () => {
    assert.deepEqual(await ids({ terms: ['acao'], channelId: CH_B }), ['c3']);
    assert.deepEqual(await ids({ terms: ['acao'], kinds: ['video'], channelId: CH_A }), ['vA1']);
  });

  it('from / to are inclusive days on the hit itself', async () => {
    assert.deepEqual(await ids({ terms: ['acao'], from: '2024-01-12' }), ['m1', 'c3', 'r1', 'c2']);
    assert.deepEqual(await ids({ terms: ['acao'], to: '2024-01-12' }), ['c2', 'c1']);
    assert.deepEqual(await ids({ terms: ['acao'], from: '2024-01-12', to: '2024-01-12' }), ['c2']);
    // A date range alone is a search (no terms needed).
    assert.deepEqual(await ids({ from: '2024-03-06', to: '2024-03-07' }), ['c5', 'c4']);
  });

  it('videoFrom / videoTo are inclusive days on the source video', async () => {
    assert.deepEqual(await ids({ terms: ['acao'], videoFrom: '2024-02-01' }), ['m1', 'c3']);
    assert.deepEqual(await ids({ terms: ['acao'], videoTo: '2024-01-10' }), ['r1', 'c2', 'c1']);
    assert.deepEqual(
      await ids({
        terms: ['acao'],
        kinds: ['video'],
        videoFrom: '2024-01-10',
        videoTo: '2024-01-10',
      }),
      ['vA1'],
    );
  });

  it('author by UC id matches the exact authorChannelId across names', async () => {
    assert.deepEqual(await ids({ author: JOAO }), ['c3', 'c1']);
    assert.deepEqual(await ids({ author: CHATTER }), ['m1']);
  });

  it('author by name is a normalized substring (accents and case folded)', async () => {
    assert.deepEqual(await ids({ author: 'joao' }), ['c3', 'c1']);
    assert.deepEqual(await ids({ author: 'JOÃO SIL' }), ['c3', 'c1']);
    assert.deepEqual(await ids({ author: 'chat' }), ['m1']);
    assert.deepEqual(await ids({ author: 'nobody' }), []);
  });

  it('an author filter excludes video hits', async () => {
    assert.deepEqual(await ids({ terms: ['acao'], author: 'joao', kinds: ['video', 'comment'] }), [
      'c3',
      'c1',
    ]);
  });

  it('timestamped keeps anchored CommentRecords and all chat, never videos', async () => {
    assert.deepEqual(
      await ids({
        terms: ['acao'],
        timestamped: true,
        kinds: ['comment', 'reply', 'chat', 'video'],
      }),
      ['m1', 'c1'],
    );
  });

  it('combines filters', async () => {
    assert.deepEqual(
      await ids({
        terms: ['acao'],
        channelId: CH_A,
        author: 'joao',
        from: '2024-01-01',
        to: '2024-01-31',
        videoFrom: '2024-01-10',
        videoTo: '2024-01-10',
        timestamped: true,
      }),
      ['c1'],
    );
  });
});

describe('searchCatalog: TTL (ADR-0001)', () => {
  it('expired comments, Replies and chat never match a term', async () => {
    const hits = await ids({ terms: ['expired'], kinds: ['comment', 'reply', 'chat'] });
    assert.deepEqual(hits, []);
  });

  it('expired rows never appear in author-only or date-only searches', async () => {
    assert.deepEqual(await ids({ author: 'ghost' }), []);
    assert.deepEqual(await ids({ author: 'UCghostghostghostghost123' }), []);
    assert.deepEqual(await ids({ from: '2024-01-14', to: '2024-01-16' }), []);
    assert.deepEqual(await ids({ from: '2024-03-05', to: '2024-03-05', kinds: ['chat'] }), ['m1']);
  });
});

describe('searchCatalog: sort and pages', () => {
  it('sorts newest, oldest and by likes (chat as 0)', async () => {
    assert.deepEqual(await ids({ terms: ['acao'], sort: 'oldest' }), [
      'c1',
      'c2',
      'r1',
      'c3',
      'm1',
    ]);
    assert.deepEqual(await ids({ terms: ['acao'], sort: 'likes' }), ['c2', 'c1', 'r1', 'm1', 'c3']);
  });

  it('pages 25 at a time; a full last page has no next page', async () => {
    const pages = await Promise.all([1, 2, 3].map((page) => search({ terms: ['paginate'], page })));
    assert.deepEqual(
      pages.map((page) => [page.page, page.hits.length, page.hasNextPage]),
      [
        [1, 25, true],
        [2, 25, false],
        [3, 0, false],
      ],
    );
    const all = pages.flatMap((page) => page.hits.map((hit) => hit.recordId));
    assert.equal(new Set(all).size, 50);
    assert.equal(all[0], 'bulk49');
    assert.equal(all.at(-1), 'bulk00');
  });

  it('rejects an out-of-range page', async () => {
    await assert.rejects(searchCatalog(sqlite, query({ terms: ['acao'], page: 41 })), RangeError);
    await assert.rejects(searchCatalog(sqlite, query({ terms: ['acao'], page: 0 })), RangeError);
  });

  it('an empty search returns no hits', async () => {
    assert.deepEqual(await search({ channelId: CH_A, kinds: ['video'] }), {
      hits: [],
      hasNextPage: false,
      page: 1,
    });
  });
});

describe('searchCatalog: statements', () => {
  it('binds every value and loads the page TimeAnchors in one extra query', async () => {
    const start = binding.bound.length;
    await searchCatalog(d1, query({ terms: ['acao'], channelId: CH_A, from: '2024-01-01' }));
    const statements = binding.bound.slice(start);
    assert.equal(statements.length, 2, 'one search query + one TimeAnchor query');
    for (const { sql } of statements) {
      assert.ok(!sql.includes('acao') && !sql.includes(CH_A) && !sql.includes('2024'), sql);
    }
    assert.match(statements[1]?.sql ?? '', /FROM time_anchors/);
  });

  it('a name author filter adds one name lookup per searched table', async () => {
    const start = binding.bound.length;
    await searchCatalog(d1, query({ author: 'joao' }));
    const statements = binding.bound.slice(start);
    assert.equal(statements.length, 4);
    assert.ok(statements.every(({ sql }) => !sql.includes('joao')));
  });
});

describe('parseSearchQuery', () => {
  it('applies defaults', () => {
    assert.deepEqual(parseSearchQuery(new URLSearchParams('')), {
      ok: true,
      query: query(),
    });
  });

  it('parses every param', () => {
    const params = new URLSearchParams({
      q: '  Ação   "Boa"  !!! ',
      channel: CH_A,
      from: '2024-01-01',
      to: '2024-01-31',
      videoFrom: '2023-12-01',
      videoTo: '2024-01-31',
      author: 'João',
      timestamped: '1',
      sort: 'likes',
      page: '3',
    });
    params.append('kind', 'video');
    params.append('kind', 'chat');
    params.append('kind', 'video');
    assert.deepEqual(parseSearchQuery(params), {
      ok: true,
      query: {
        terms: ['acao', 'boa'],
        kinds: ['video', 'chat'],
        channelId: CH_A,
        from: '2024-01-01',
        to: '2024-01-31',
        videoFrom: '2023-12-01',
        videoTo: '2024-01-31',
        author: 'joao',
        timestamped: true,
        sort: 'likes',
        page: 3,
      },
    });
  });

  it('accepts a record of strings / string arrays and treats empty values as absent', () => {
    const parsed = parseSearchQuery({
      q: ['foo', 'bar'],
      kind: ['reply'],
      author: JOAO,
      channel: '',
      timestamped: '0',
    });
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.query.terms, ['foo', 'bar']);
    assert.deepEqual(parsed.query.kinds, ['reply']);
    assert.equal(parsed.query.author, JOAO);
    assert.equal(parsed.query.channelId, null);
    assert.equal(parsed.query.timestamped, false);
  });

  it('rejects invalid params with one message each', () => {
    const parsed = parseSearchQuery({
      q: 'a bb',
      kind: ['comment', 'post'],
      channel: 'UCshort',
      from: '2024-02-30',
      to: 'yesterday',
      videoFrom: '2024-03-01',
      videoTo: '2024-02-01',
      author: '!!!',
      timestamped: 'yes',
      sort: 'best',
      page: '41',
    });
    assert.equal(parsed.ok, false);
    assert.ok(!parsed.ok);
    const fields = parsed.errors.map((error) => error.split(':')[0]);
    assert.deepEqual(fields, [
      'q',
      'kind',
      'channel',
      'from',
      'to',
      'videoFrom',
      'author',
      'timestamped',
      'sort',
      'page',
    ]);
  });

  it('rejects more than 8 terms, and pages outside 1..40', () => {
    const many = parseSearchQuery({ q: 'aa bb cc dd ee ff gg hh ii' });
    assert.deepEqual(many, { ok: false, errors: ['q: at most 8 terms, got 9'] });
    assert.ok(parseSearchQuery({ q: 'aa bb cc dd ee ff gg hh' }).ok);
    for (const page of ['0', '-1', '1.5', 'x']) {
      assert.equal(parseSearchQuery({ page }).ok, false, page);
    }
    assert.ok(parseSearchQuery({ page: '40' }).ok);
    assert.equal(parseSearchQuery({ from: '2024-02-01', to: '2024-01-01' }).ok, false);
  });
});

describe('isEmptySearch', () => {
  it('is true with no terms, author or date range', () => {
    assert.equal(
      isEmptySearch(query({ channelId: CH_A, kinds: ['video'], timestamped: true })),
      true,
    );
    assert.equal(isEmptySearch(query({ terms: ['aa'] })), false);
    assert.equal(isEmptySearch(query({ author: 'joao' })), false);
    assert.equal(isEmptySearch(query({ from: '2024-01-01' })), false);
    assert.equal(isEmptySearch(query({ videoTo: '2024-01-01' })), false);
  });
});
