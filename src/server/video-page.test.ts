/**
 * Integration tests for the v2 video page, F7 (#54): `GET /v/:videoId` for an
 * upload, a Broadcast with and without captured chat (ADR-0009), Replies
 * nested under their top-level CommentRecord, and expired LiveChatMessages
 * (ADR-0001). Each case seeds a `:memory:` Catalog with SQL rows the way
 * migration 0003 stores them and drives the real app (`createApp`).
 *
 * Run via `pnpm test` (node:test runner, through tsx).
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openCatalog, type SqliteExecutor } from '../db/sqlite.ts';
import { createApp } from './app.ts';

const CH = 'UC_f7_channel';
const DAY_MS = 86_400_000;
const FRESH = new Date(Date.now() - DAY_MS).toISOString();
const EXPIRED = new Date(Date.now() - 31 * DAY_MS).toISOString();

let db: SqliteExecutor;

interface VideoSeed {
  id: string;
  kind?: 'upload' | 'broadcast';
  state?: 'live' | 'ended' | null;
  start?: string | null;
  end?: string | null;
  duration?: string;
}

async function seedVideo(seed: VideoSeed): Promise<void> {
  await db.run(
    `INSERT INTO videos (id, channel_id, title, description, published_at, thumbnail_url,
       duration_iso8601, fetched_at, kind, broadcast_state, actual_start_time, actual_end_time)
     VALUES (?, ?, ?, '', '2026-01-01T09:00:00.000Z', 'https://example.com/t.jpg', ?, ?, ?, ?, ?, ?)`,
    [
      seed.id,
      CH,
      `Title ${seed.id}`,
      seed.duration ?? 'PT5M',
      FRESH,
      seed.kind ?? 'upload',
      seed.state ?? null,
      seed.start ?? null,
      seed.end ?? null,
    ],
  );
}

interface CommentSeed {
  id: string;
  videoId: string;
  text?: string;
  publishedAt: string;
  parentId?: string;
  anchors?: Array<{ seconds: number; rawText: string; charPosition: number }>;
}

async function seedComment(seed: CommentSeed): Promise<void> {
  const anchors = seed.anchors ?? [];
  await db.run(
    `INSERT INTO comments (id, video_id, channel_id, author, text, published_at, like_count,
       has_anchors, fetched_at, author_channel_id, parent_id)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, '', ?)`,
    [
      seed.id,
      seed.videoId,
      CH,
      `Author ${seed.id}`,
      seed.text ?? `Comment ${seed.id}`,
      seed.publishedAt,
      anchors.length > 0 ? 1 : 0,
      FRESH,
      seed.parentId ?? null,
    ],
  );
  for (const anchor of anchors) {
    await db.run(
      'INSERT INTO time_anchors (comment_id, seconds, raw_text, char_position) VALUES (?, ?, ?, ?)',
      [seed.id, anchor.seconds, anchor.rawText, anchor.charPosition],
    );
  }
}

async function seedChat(
  id: string,
  videoId: string,
  offset: number,
  text: string,
  fetchedAt = FRESH,
): Promise<void> {
  await db.run(
    `INSERT INTO live_chat_messages (id, video_id, channel_id, author, author_channel_id, text,
       published_at, offset_seconds, fetched_at) VALUES (?, ?, ?, ?, '', ?, ?, ?, ?)`,
    [
      id,
      videoId,
      CH,
      `Chatter ${id}`,
      text,
      new Date(Date.parse('2026-01-01T10:00:00.000Z') + offset * 1000).toISOString(),
      offset,
      fetchedAt,
    ],
  );
}

async function get(path: string): Promise<{ status: number; body: string }> {
  const app = await createApp({ db });
  const res = await app.request(path);
  return { status: res.status, body: await res.text() };
}

/** The `<li …>…</li>` element with `id="{elementId}"`, up to its closing tag. */
function element(body: string, elementId: string): string {
  const start = body.indexOf(`id="${elementId}"`);
  assert.ok(start >= 0, `element #${elementId} is rendered`);
  return body.slice(body.lastIndexOf('<li', start), body.indexOf('</li>', start));
}

beforeEach(async () => {
  db = await openCatalog(':memory:');
  await db.run(
    'INSERT INTO channels (id, title, uploads_playlist_id, fetched_at) VALUES (?, ?, ?, ?)',
    [CH, 'F7 Channel', 'UU_f7_channel', FRESH],
  );
});

afterEach(() => db.close());

describe('GET /v/:videoId (F7 #54)', () => {
  it('renders an upload with no Broadcast badge and no chat panel', async () => {
    await seedVideo({ id: 'up1' });
    await seedComment({ id: 'c1', videoId: 'up1', publishedAt: '2026-01-02T00:00:00.000Z' });
    const { status, body } = await get('/v/up1');
    assert.equal(status, 200);
    assert.ok(body.includes('id="c-c1"'));
    // Markup only: the inline stylesheet names these classes too.
    assert.ok(!body.includes('class="broadcast-badge'));
    assert.ok(!body.includes('class="broadcast-line"'));
    assert.ok(!body.includes('class="card chat-panel"'));
    assert.ok(!body.includes('Chat not captured'));
    assert.ok(!body.includes('class="watch-side"'), 'the side column is unchanged for uploads');
  });

  it('renders an ended Broadcast with its badge, real start, duration and ordered chat', async () => {
    await seedVideo({
      id: 'bc1',
      kind: 'broadcast',
      state: 'ended',
      start: '2026-01-01T10:00:00.000Z',
      end: '2026-01-01T11:02:03.000Z',
      duration: 'PT1H',
    });
    await seedChat('m-late', 'bc1', 3725, 'later');
    await seedChat('m-early', 'bc1', 65, 'first!');
    const { body } = await get('/v/bc1');

    assert.match(body, /class="broadcast-badge[^"]*"[^>]*>\s*Broadcast\s*</);
    assert.ok(body.includes('datetime="2026-01-01T10:00:00.000Z"'));
    assert.ok(body.includes('Started 2026-01-01 10:00 UTC'));
    assert.ok(body.includes('1:02:03'), 'duration comes from the actual start / end');
    assert.match(body, /<h2 id="chat-title">[\s\S]*?Live chat<\/h2>/);

    const early = body.indexOf('id="m-m-early"');
    const late = body.indexOf('id="m-m-late"');
    assert.ok(early >= 0 && late > early, 'messages are ordered by offset');
    const earlyItem = element(body, 'm-m-early');
    assert.ok(earlyItem.includes('href="https://www.youtube.com/watch?v=bc1&t=65s"'));
    assert.ok(earlyItem.includes('target="_blank"'));
    assert.ok(earlyItem.includes('rel="noopener noreferrer"'));
    assert.ok(earlyItem.includes('>1:05<'));
    assert.ok(earlyItem.includes('Chatter m-early'));
    assert.ok(earlyItem.includes('first!'));
    assert.ok(element(body, 'm-m-late').includes('>1:02:05<'));
    assert.ok(!body.includes('Chat not captured'));
  });

  it('shows a live Broadcast as Live and falls back to the stored duration without an end', async () => {
    await seedVideo({
      id: 'bc2',
      kind: 'broadcast',
      state: 'live',
      start: '2026-01-01T10:00:00.000Z',
      duration: 'PT12M',
    });
    await seedChat('m1', 'bc2', 1, 'hello');
    const { body } = await get('/v/bc2');
    assert.match(body, /class="broadcast-badge[^"]*"[^>]*>\s*Live\s*</);
    assert.ok(body.includes('12:00'));
  });

  it('says "Chat not captured" for an ended Broadcast without LiveChatMessages', async () => {
    await seedVideo({
      id: 'bc3',
      kind: 'broadcast',
      state: 'ended',
      start: '2026-01-01T10:00:00.000Z',
      end: '2026-01-01T10:30:00.000Z',
    });
    const { body } = await get('/v/bc3');
    assert.match(body, /<h2 id="chat-title">[\s\S]*?Live chat<\/h2>/);
    assert.ok(body.includes('Chat not captured'));
  });

  it('keeps the link of an expired LiveChatMessage and shows the placeholder text', async () => {
    await seedVideo({ id: 'bc4', kind: 'broadcast', state: 'ended' });
    await seedChat('old', 'bc4', 42, 'secret original text', EXPIRED);
    const { body } = await get('/v/bc4');
    const item = element(body, 'm-old');
    assert.ok(item.includes('[Message text expired — refresh to recover]'));
    assert.ok(item.includes('href="https://www.youtube.com/watch?v=bc4&t=42s"'));
    assert.ok(item.includes('expired'));
    assert.ok(!body.includes('secret original text'));
  });

  it('escapes chat text, author and ids', async () => {
    await seedVideo({ id: 'bc5', kind: 'broadcast', state: 'ended' });
    await seedChat('x"><b>', 'bc5', 3, '<script>alert(1)</script> & "quotes"');
    const { body } = await get('/v/bc5');
    assert.ok(!body.includes('<script>alert(1)</script>'));
    assert.ok(body.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;'));
    assert.ok(body.includes('id="m-x&quot;&gt;&lt;b&gt;"'));
    assert.ok(!body.includes('x"><b>'));
  });

  it('nests Replies oldest-first under their parent, with c- ids', async () => {
    await seedVideo({ id: 'up2' });
    await seedComment({ id: 'top-old', videoId: 'up2', publishedAt: '2026-01-02T00:00:00.000Z' });
    await seedComment({ id: 'top-new', videoId: 'up2', publishedAt: '2026-01-05T00:00:00.000Z' });
    await seedComment({
      id: 'top-old.r2',
      videoId: 'up2',
      parentId: 'top-old',
      publishedAt: '2026-01-04T00:00:00.000Z',
    });
    await seedComment({
      id: 'top-old.r1',
      videoId: 'up2',
      parentId: 'top-old',
      publishedAt: '2026-01-03T00:00:00.000Z',
    });
    const { body } = await get('/v/up2');

    const order = ['c-top-new', 'c-top-old', 'c-top-old.r1', 'c-top-old.r2'].map((id) =>
      body.indexOf(`id="${id}"`),
    );
    assert.ok(
      order.every((index, i) => index >= 0 && (i === 0 || index > (order[i - 1] ?? 0))),
      `top-level newest-first, Replies oldest-first under their parent: ${order.join(',')}`,
    );
    // The Replies sit inside the parent's element, in a nested list.
    const parentStart = body.indexOf('id="c-top-old"');
    const replies = body.indexOf('class="replies"', parentStart);
    assert.ok(replies > parentStart && replies < body.indexOf('id="c-top-old.r1"'));
    assert.ok(body.indexOf('id="c-top-new"') < parentStart);
    assert.ok(body.includes('All <span class="chip-count">4</span>'));
  });

  it('counts a timestamped Reply and marks its parent as context for the filter', async () => {
    await seedVideo({ id: 'up3' });
    await seedComment({ id: 'p', videoId: 'up3', publishedAt: '2026-01-02T00:00:00.000Z' });
    await seedComment({
      id: 'p.r',
      videoId: 'up3',
      parentId: 'p',
      text: 'see 1:23',
      publishedAt: '2026-01-03T00:00:00.000Z',
      anchors: [{ seconds: 83, rawText: '1:23', charPosition: 4 }],
    });
    const { body } = await get('/v/up3');
    assert.match(body, /Timestamped\s*<span class="chip-count">1<\/span>/);
    assert.match(element(body, 'c-p'), /class="comment has-timestamped-reply"/);
    assert.match(element(body, 'c-p.r'), /class="comment reply timestamped"/);
    assert.ok(body.includes('https://www.youtube.com/watch?v=up3&t=83s'));
  });

  it('renders a Reply whose parent is not in the list at the top level', async () => {
    await seedVideo({ id: 'up4' });
    await db.run('PRAGMA foreign_keys = OFF');
    await seedComment({
      id: 'orphan',
      videoId: 'up4',
      parentId: 'gone',
      publishedAt: '2026-01-03T00:00:00.000Z',
    });
    const { body } = await get('/v/up4');
    assert.ok(body.includes('id="c-orphan"'));
    assert.ok(!body.includes('class="replies"'));
  });
});
