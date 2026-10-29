/**
 * Integration tests for the public `GET /search` page: ticket F5 (#53),
 * ADR-0010, spec v2 "SearchQuery contract" and "SearchHit links".
 *
 * Each case drives the real app (`createApp`) over a seeded `:memory:`
 * Catalog whose rows carry `search_text` written by `normalizeSearchText`, as
 * Ingest does, so routing, `searchCatalog` and the SSR template all run end
 * to end. A comment fetched 31 days ago proves expired text never renders
 * (ADR-0001).
 *
 * Run via `pnpm test` (node:test runner, through tsx).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSearchText } from '../db/search-text.ts';
import { openCatalog, type SqliteExecutor } from '../db/sqlite.ts';
import { createApp } from './app.ts';

const CH = 'UCsearchsearchsearch1234';
const DAY_MS = 86_400_000;
const FRESH = new Date(Date.now() - DAY_MS).toISOString();
const EXPIRED = new Date(Date.now() - 31 * DAY_MS).toISOString();

let db: SqliteExecutor;
let app: Awaited<ReturnType<typeof createApp>>;

async function seedVideo(id: string, title: string): Promise<void> {
  await db.run(
    `INSERT INTO videos (id, channel_id, title, description, published_at, thumbnail_url,
       fetched_at, search_text) VALUES (?, ?, ?, '', ?, '', ?, ?)`,
    [id, CH, title, FRESH, FRESH, normalizeSearchText(title)],
  );
}

interface CommentSeed {
  id: string;
  videoId?: string;
  author: string;
  text: string;
  publishedAt?: string;
  parentId?: string;
  anchors?: number[];
  fetchedAt?: string;
}

async function seedComment(seed: CommentSeed): Promise<void> {
  const anchors = seed.anchors ?? [];
  await db.run(
    `INSERT INTO comments (id, video_id, channel_id, author, text, published_at, like_count,
       has_anchors, fetched_at, author_channel_id, parent_id, search_text)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, '', ?, ?)`,
    [
      seed.id,
      seed.videoId ?? 'vid-1',
      CH,
      seed.author,
      seed.text,
      seed.publishedAt ?? FRESH,
      anchors.length > 0 ? 1 : 0,
      seed.fetchedAt ?? FRESH,
      seed.parentId ?? null,
      normalizeSearchText(seed.text),
    ],
  );
  for (const [index, seconds] of anchors.entries()) {
    await db.run(
      'INSERT INTO time_anchors (comment_id, seconds, raw_text, char_position) VALUES (?, ?, ?, ?)',
      [seed.id, seconds, String(seconds), index],
    );
  }
}

before(async () => {
  db = await openCatalog(':memory:');
  await db.run(
    'INSERT INTO channels (id, title, uploads_playlist_id, fetched_at) VALUES (?, ?, ?, ?)',
    [CH, 'Search Channel', 'UUsearch', FRESH],
  );
  await seedVideo('vid-1', 'The grand finale');
  await seedVideo('vid-2', 'Bulk upload');
  await seedComment({
    id: 'c-anchored',
    author: 'Alice',
    text: 'Zebra moments at 1:23 and 1:02:05',
    anchors: [83, 3725],
  });
  await seedComment({ id: 'c-plain', author: 'Bob', text: 'Zebra without any timestamp' });
  await seedComment({
    id: 'c-reply',
    author: 'Carol',
    text: 'Quagga reply here',
    parentId: 'c-plain',
  });
  await seedComment({
    id: 'c-xss',
    author: 'Mallory',
    text: 'Uma AÇÃO <script>alert(1)</script> incrível',
  });
  await seedComment({
    id: 'c-expired',
    author: 'Eve',
    text: 'Okapi secretexpiredword',
    fetchedAt: EXPIRED,
  });
  for (let index = 0; index < 30; index += 1) {
    await seedComment({
      id: `c-bulk-${index}`,
      videoId: 'vid-2',
      author: `Bulk ${index}`,
      text: `walrus number ${index}`,
      publishedAt: new Date(Date.now() - (index + 2) * DAY_MS).toISOString(),
    });
  }
  await db.run(
    `INSERT INTO live_chat_messages (id, video_id, channel_id, author, author_channel_id, text,
       published_at, offset_seconds, search_text, fetched_at)
     VALUES ('m-1', 'vid-1', ?, 'Dave', '', 'Narwhal in chat', ?, 3725, ?, ?)`,
    [CH, FRESH, normalizeSearchText('Narwhal in chat'), FRESH],
  );
  app = await createApp({ db });
});

after(() => {
  db.close();
});

async function search(query: string): Promise<{ status: number; body: string }> {
  const res = await app.request(`/search?${query}`);
  return { status: res.status, body: await res.text() };
}

/** The HTML-attribute form of a URL, as the `html` helper escapes it. */
function attr(url: string): string {
  return url.replaceAll('&', '&amp;');
}

describe('GET /search', () => {
  it('renders the empty form without running a SearchQuery', async () => {
    const { status, body } = await search('');
    assert.equal(status, 200);
    assert.ok(body.includes('<form class="search-form'));
    assert.ok(body.includes('action="/search"'));
    assert.ok(!body.includes('class="search-hit'));
    assert.ok(!body.includes('Nothing in the Catalog matches'));
  });

  it('links an anchored comment to its first anchor and to every anchor', async () => {
    const { status, body } = await search('q=zebra');
    assert.equal(status, 200);
    assert.ok(body.includes('href="/v/vid-1#c-c-anchored"'));
    assert.ok(body.includes(attr('href="https://www.youtube.com/watch?v=vid-1&t=83s"')));
    assert.ok(body.includes(attr('https://www.youtube.com/watch?v=vid-1&t=3725s"')));
    assert.ok(body.includes('>1:23</a'));
    assert.ok(body.includes('>1:02:05</a'));
    assert.ok(body.includes('target="_blank"'));
    assert.ok(body.includes('rel="noopener noreferrer"'));
  });

  it('links a comment without anchors to YouTube with lc=', async () => {
    const { body } = await search('q=zebra');
    assert.ok(body.includes('href="/v/vid-1#c-c-plain"'));
    assert.ok(body.includes(attr('href="https://www.youtube.com/watch?v=vid-1&lc=c-plain"')));
  });

  it('says which comment a Reply answers', async () => {
    const { body } = await search('q=quagga');
    assert.ok(body.includes('href="/v/vid-1#c-c-reply"'));
    assert.match(body, /Reply to <span class="author">Bob<\/span>/);
  });

  it('links a LiveChatMessage to its offset', async () => {
    const { body } = await search('q=narwhal');
    assert.ok(body.includes('href="/v/vid-1#m-m-1"'));
    assert.ok(body.includes(attr('href="https://www.youtube.com/watch?v=vid-1&t=3725s"')));
    assert.ok(body.includes('Live chat'));
  });

  it('links a video hit to the plain watch page', async () => {
    const { body } = await search('q=finale&kind=video');
    assert.ok(body.includes('href="/v/vid-1"'));
    assert.ok(body.includes('href="https://www.youtube.com/watch?v=vid-1"'));
    assert.ok(body.includes('The grand <mark>finale</mark>'));
  });

  it('highlights accent-insensitive matches in escaped text', async () => {
    const { body } = await search('q=acao+incrivel');
    assert.ok(body.includes('<mark>AÇÃO</mark>'));
    assert.ok(body.includes('<mark>incrível</mark>'));
    assert.ok(body.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(!body.includes('<script>alert(1)'));
  });

  it('never shows expired comment text', async () => {
    const { status, body } = await search('q=okapi');
    assert.equal(status, 200);
    assert.ok(!body.includes('secretexpiredword'));
    assert.ok(body.includes('Nothing in the Catalog matches'));
  });

  it('shows a no-results message when nothing matches', async () => {
    const { status, body } = await search('q=nothingmatchesthis');
    assert.equal(status, 200);
    assert.ok(body.includes('Nothing in the Catalog matches'));
  });

  it('paginates with links that keep every param', async () => {
    const first = await search('q=walrus&kind=comment&sort=oldest');
    assert.equal(first.status, 200);
    assert.equal((first.body.match(/class="search-hit card"/g) ?? []).length, 25);
    assert.ok(first.body.includes(attr('href="/search?q=walrus&kind=comment&sort=oldest&page=2"')));
    assert.ok(!first.body.includes('rel="prev"'));

    const second = await search('q=walrus&kind=comment&sort=oldest&page=2');
    assert.equal((second.body.match(/class="search-hit card"/g) ?? []).length, 5);
    assert.ok(
      second.body.includes(attr('href="/search?q=walrus&kind=comment&sort=oldest&page=1"')),
    );
    assert.ok(!second.body.includes('rel="next"'));
  });

  it('keeps submitted values in the form', async () => {
    const { body } = await search(
      `q=walrus&kind=reply&channel=${CH}&from=2026-01-01&author=bob&timestamped=1&sort=likes`,
    );
    assert.ok(body.includes('name="q"'));
    assert.ok(body.includes('value="walrus"'));
    assert.match(body, /value="reply"\s+checked/);
    assert.doesNotMatch(body, /value="comment"\s+checked/);
    assert.match(body, new RegExp(`value="${CH}"\\s+selected`));
    assert.ok(body.includes('value="2026-01-01"'));
    assert.ok(body.includes('value="bob"'));
    assert.match(body, /name="timestamped"\s+value="1"\s+checked/);
    assert.match(body, /value="likes"\s+selected/);
  });

  it('answers invalid params with 400 and inline messages', async () => {
    for (const query of ['q=walrus&page=99', 'from=bad']) {
      const { status, body } = await search(query);
      assert.equal(status, 400, query);
      assert.ok(body.includes('class="search-errors"'), query);
      assert.ok(body.includes('<form class="search-form'), query);
    }
    const { body } = await search('from=bad');
    assert.ok(body.includes('from:'));
  });
});

describe('top app bar search', () => {
  it('submits to /search as q', async () => {
    const res = await app.request('/');
    const body = await res.text();
    assert.match(body, /<form[^>]*class="search"[^>]*method="get"[^>]*action="\/search"/);
    assert.ok(body.includes('name="q"'));
  });
});
