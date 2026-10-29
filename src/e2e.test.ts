/**
 * End-to-end fixture test for v2 (`src/e2e`): ticket D1 (#55), spec v2.
 *
 * One Ingest of a fixture Channel through `runIngest` (`./cli/ingest.ts`)
 * with `--live-chat`, then the same SQLite Catalog read back through the
 * Hono app (`createApp`) exactly as a browser would: `/search` by terms,
 * date range, author (folded name and `UC…` id) and record kind, then the
 * SearchHit's app link into `/v/:videoId`. No network: YouTube is a fake
 * `transport`, the clock is a fake `now` / `sleep` pair, and the Catalog is
 * a throwaway file under the OS temp dir (`runIngest` closes its own
 * connection, so `:memory:` would not survive it).
 *
 * The clock starts at the real wall-clock time, captured once: TTL
 * redaction (ADR-0001) compares `fetched_at` with SQLite's `now`, so a
 * Catalog fetched in 2024 would read back expired. Every YouTube timestamp
 * in the fixture is fixed.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import type {
  CommentResource,
  CommentThreadListResponse,
  LiveChatMessageListResponse,
  PlaylistItemListResponse,
  Transport,
  VideoResource,
} from './yt/client.ts';
import { QuotaCounter } from './yt/quota.ts';
import { openCatalog, type SqliteExecutor } from './db/sqlite.ts';
import { runIngest } from './cli/ingest.ts';
import { createApp } from './server/app.ts';

// ---------------------------------------------------------------------------
// Fixture Channel
// ---------------------------------------------------------------------------

/** A `UC` + 22-character channel id, as `/search?author=` requires. */
function channelId(seed: string): string {
  return `UC${seed.padEnd(22, '0')}`;
}

const CHANNEL_ID = channelId('e2eChannel');
const JOSE_ID = channelId('jose');
const BOB_ID = channelId('bob');
const CAROL_ID = channelId('carol');
const ERIN_ID = channelId('erin');

const PLAYLIST: PlaylistItemListResponse = {
  items: ['up1', 'live1'].map((videoId) => ({
    id: `PL_${videoId}`,
    snippet: { title: videoId, publishedAt: '2024-01-01T00:00:00Z', resourceId: { videoId } },
  })),
};

function video(id: string, title: string, extra: Partial<VideoResource> = {}): VideoResource {
  return {
    id,
    snippet: {
      title,
      description: '',
      publishedAt: '2024-01-01T00:00:00Z',
      channelId: CHANNEL_ID,
      liveBroadcastContent: 'none',
      thumbnails: {},
    },
    contentDetails: { duration: 'PT10M' },
    statistics: { viewCount: '100', likeCount: '10', commentCount: '3' },
    ...extra,
  };
}

/** An upload, and a Broadcast on air during the run (ADR-0009). */
const VIDEOS: VideoResource[] = [
  video('up1', 'Drum Session'),
  {
    ...video('live1', 'Live Concert'),
    snippet: {
      ...video('live1', 'Live Concert').snippet,
      liveBroadcastContent: 'live',
    },
    liveStreamingDetails: {
      actualStartTime: '2024-03-01T20:00:00Z',
      activeLiveChatId: 'chat1',
    },
  },
];

function comment(
  id: string,
  author: string,
  authorChannelId: string,
  text: string,
  publishedAt: string,
  parentId?: string,
): CommentResource {
  return {
    id,
    snippet: {
      authorDisplayName: author,
      authorChannelId: { value: authorChannelId },
      textOriginal: text,
      publishedAt,
      likeCount: 2,
      ...(parentId !== undefined ? { parentId } : {}),
    },
  };
}

/**
 * `up1`: c1 carries a TimeAnchor ("at 1:23" → 83 s) and one embedded Reply;
 * c2 is from January, outside the date range the test filters on.
 */
const COMMENT_THREADS: Record<string, CommentThreadListResponse> = {
  up1: {
    items: [
      {
        id: 'c1',
        snippet: {
          topLevelComment: comment(
            'c1',
            'José Núñez',
            JOSE_ID,
            'That drum solo at 1:23 is unreal',
            '2024-02-10T12:00:00Z',
          ),
          totalReplyCount: 1,
        },
        replies: {
          comments: [
            comment('r1', 'Bob', BOB_ID, 'Agreed, unreal fill', '2024-02-11T08:00:00Z', 'c1'),
          ],
        },
      },
      {
        id: 'c2',
        snippet: {
          topLevelComment: comment(
            'c2',
            'Carol',
            CAROL_ID,
            'Early bird, the drum tone is great',
            '2024-01-05T09:00:00Z',
          ),
          totalReplyCount: 0,
        },
      },
    ],
  },
  live1: { items: [] },
};

/** Two polls of `chat1`; the second reports the Broadcast offline. */
const CHAT_PAGES: LiveChatMessageListResponse[] = [
  {
    items: [
      {
        id: 'm1',
        snippet: {
          type: 'textMessageEvent',
          publishedAt: '2024-03-01T20:01:05Z',
          textMessageDetails: { messageText: 'Hello from the front row' },
        },
        authorDetails: { displayName: 'José Núñez', channelId: JOSE_ID },
      },
    ],
    nextPageToken: '1',
    pollingIntervalMillis: 5000,
  },
  {
    items: [
      {
        id: 'm2',
        snippet: {
          type: 'textMessageEvent',
          publishedAt: '2024-03-01T20:10:00Z',
          displayMessage: 'Encore please',
        },
        authorDetails: { displayName: 'Erin', channelId: ERIN_ID },
      },
    ],
    nextPageToken: '2',
    pollingIntervalMillis: 5000,
    offlineAt: '2024-03-01T20:11:00Z',
  },
];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Fake YouTube Data API: serves the fixture by endpoint and page token. */
const transport: Transport = async (url) => {
  const parsed = new URL(url);
  const path = parsed.pathname;
  const token = parsed.searchParams.get('pageToken');
  if (path.endsWith('/channels')) {
    return json({
      items: [
        {
          id: CHANNEL_ID,
          snippet: { title: 'E2E Channel' },
          contentDetails: { relatedPlaylists: { uploads: 'UU_e2e' } },
        },
      ],
    });
  }
  if (path.endsWith('/playlistItems')) return json(PLAYLIST);
  if (path.endsWith('/videos')) return json({ items: VIDEOS });
  if (path.endsWith('/commentThreads')) {
    const thread = COMMENT_THREADS[parsed.searchParams.get('videoId') ?? ''];
    if (thread === undefined) throw new Error(`fake transport: no threads for ${url}`);
    return json(thread);
  }
  if (path.endsWith('/liveChat/messages')) {
    assert.equal(parsed.searchParams.get('liveChatId'), 'chat1');
    const page = CHAT_PAGES[token === null ? 0 : Number(token)];
    if (page === undefined) throw new Error(`fake transport: no chat page ${token}`);
    return json(page);
  }
  throw new Error(`fake transport: unexpected URL ${url}`);
};

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

/** A SearchHit card as a browser sees it: kind, resolved links, text. */
interface RenderedHit {
  kind: string;
  /** The "Open in ytb-index" link. */
  app: string;
  /** The "Watch on YouTube" link. */
  youtube: string;
  text: string;
}

/** Undo the attribute escaping a browser resolves (`&amp;` → `&`). */
function decode(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function hrefs(fragment: string): string[] {
  return [...fragment.matchAll(/href="([^"]*)"/g)].map((match) => decode(match[1]!));
}

/** Every SearchHit card on a `/search` page, in order. */
function parseHits(body: string): RenderedHit[] {
  return body
    .split('<li class="search-hit card">')
    .slice(1)
    .map((card) => {
      const segment = card.split('</li>')[0]!;
      const links = hrefs(segment);
      const kind = /search-kind-(\w+)/.exec(segment)?.[1] ?? '';
      const snippet = /<p class="search-hit-snippet">([\s\S]*?)<\/p>/.exec(segment)?.[1] ?? '';
      return {
        kind,
        app: links.find((href) => href.startsWith('/v/')) ?? '',
        youtube: links.filter((href) => href.startsWith('https://www.youtube.com/')).at(-1) ?? '',
        text: decode(snippet.replace(/<[^>]*>/g, '')).trim(),
      };
    });
}

/** The record id a SearchHit's app link points at (`c-…` / `m-…`). */
function fragmentOf(hit: RenderedHit): string {
  return decodeURIComponent(new URL(hit.app, 'http://app.test').hash.slice(1));
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

describe('v2 end to end: Ingest with live chat, then /search and the video page (D1)', () => {
  let tempDir: string;
  let db: SqliteExecutor;
  let app: Hono;
  const quota = new QuotaCounter();
  const sleeps: number[] = [];
  const output: string[] = [];

  before(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ytb-e2e-'));
    const dbPath = join(tempDir, 'catalog.sqlite');
    const envBefore = {
      key: process.env['YOUTUBE_API_KEY'],
      sealed: process.env['INGEST_SEALED_KEY'],
    };
    process.env['YOUTUBE_API_KEY'] = `AIza${'e'.repeat(35)}`;
    delete process.env['INGEST_SEALED_KEY'];

    let clockMs = Math.floor(Date.now() / 1000) * 1000;
    const originalOut = process.stdout.write;
    const originalErr = process.stderr.write;
    const capture = ((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stdout.write = capture;
    process.stderr.write = capture;
    let code: number;
    try {
      code = await runIngest({
        channel: '@e2e',
        dbPath,
        transport,
        quota,
        liveChat: true,
        now: () => new Date(clockMs),
        sleep: async (ms) => {
          sleeps.push(ms);
          clockMs += ms;
        },
      });
    } finally {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
      for (const [name, value] of [
        ['YOUTUBE_API_KEY', envBefore.key],
        ['INGEST_SEALED_KEY', envBefore.sealed],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    assert.equal(code, 0, output.join(''));

    db = await openCatalog(dbPath);
    app = await createApp({ db });
  });

  after(() => {
    db?.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function get(path: string): Promise<string> {
    const response = await app.request(path);
    assert.equal(response.status, 200, `GET ${path}`);
    return response.text();
  }

  async function search(params: Record<string, string | string[]>): Promise<RenderedHit[]> {
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(params)) {
      for (const one of Array.isArray(value) ? value : [value]) query.append(name, one);
    }
    return parseHits(await get(`/search?${query.toString()}`));
  }

  it('ingests the upload, its Reply, and the on-air Broadcast chat until offlineAt', () => {
    const summary = output.join('');
    assert.match(
      summary,
      /channels=1 videos=2 comments=2 anchors=1 duration=\d+\.\ds quota=15 replies=1 skipped=0 chat=2\n/,
    );
    // channels + playlistItems + videos + commentThreads ×2, then 5 per chat poll.
    assert.equal(quota.total, 15);
    // One wait between the two polls, none after the offline page.
    assert.deepEqual(sleeps, [5000]);
  });

  it('finds the anchored comment by term, linked at the exact second and to its element', async () => {
    const hits = await search({ q: 'drum solo' });
    assert.equal(hits.length, 1);
    const [hit] = hits;
    assert.equal(hit!.kind, 'comment');
    assert.equal(hit!.youtube, 'https://www.youtube.com/watch?v=up1&t=83s');
    assert.equal(hit!.app, '/v/up1#c-c1');
    assert.match(hit!.text, /That drum solo at 1:23 is unreal/);
    // The Reply shares the term but carries no TimeAnchor of its own.
    assert.deepEqual(
      (await search({ q: 'unreal' })).map((one) => fragmentOf(one)),
      ['c-r1', 'c-c1'],
    );
    assert.deepEqual(
      (await search({ q: 'unreal', timestamped: '1' })).map((one) => fragmentOf(one)),
      ['c-c1'],
    );
  });

  it('keeps the date range inclusive and excludes records written outside it', async () => {
    const february = await search({ q: 'drum', from: '2024-02-01', to: '2024-02-29' });
    assert.deepEqual(
      february.map((hit) => fragmentOf(hit)),
      ['c-c1'],
    );
    const january = await search({ q: 'drum', from: '2024-01-01', to: '2024-01-31' });
    assert.deepEqual(
      january.map((hit) => fragmentOf(hit)),
      ['c-c2'],
    );
    // A date-only search spans every default kind: the Reply, not the chat.
    const dateOnly = await search({ from: '2024-02-11', to: '2024-02-11' });
    assert.deepEqual(
      dateOnly.map((hit) => [hit.kind, fragmentOf(hit)]),
      [['reply', 'c-r1']],
    );
    assert.deepEqual(await search({ q: 'drum', from: '2024-04-01' }), []);
  });

  it("finds an author's comment and chat message by folded name and by UC id", async () => {
    const expected = [
      ['chat', 'm-m1'],
      ['comment', 'c-c1'],
    ];
    for (const author of ['nunez', 'JOSE', JOSE_ID]) {
      const hits = await search({ author });
      assert.deepEqual(
        hits.map((hit) => [hit.kind, fragmentOf(hit)]),
        expected,
        `author=${author}`,
      );
    }
    assert.deepEqual(await search({ author: channelId('nobody') }), []);
  });

  it('links a chat hit to YouTube at its offset from actualStartTime', async () => {
    const hits = await search({ q: 'encore', kind: 'chat' });
    assert.equal(hits.length, 1);
    const [hit] = hits;
    assert.equal(hit!.kind, 'chat');
    // 20:10:00 − 20:00:00 = 600 s.
    assert.equal(hit!.youtube, 'https://www.youtube.com/watch?v=live1&t=600s');
    assert.equal(hit!.app, '/v/live1#m-m2');
    // kind=chat leaves out CommentRecords that do match the term.
    assert.deepEqual(await search({ q: 'drum', kind: 'chat' }), []);
  });

  it('follows the app links to the record elements and the chat panel', async () => {
    const [commentHit] = await search({ q: 'drum solo' });
    const upload = await get(commentHit!.app.split('#')[0]!);
    assert.ok(upload.includes(`id="${fragmentOf(commentHit!)}"`));
    assert.ok(upload.includes('id="c-r1"'), 'the Reply has its own element');
    assert.ok(!upload.includes('class="card chat-panel"'), 'an upload has no chat panel');

    const [chatHit] = await search({ q: 'front row', kind: 'chat' });
    assert.equal(chatHit!.app, '/v/live1#m-m1');
    const broadcast = await get(chatHit!.app.split('#')[0]!);
    assert.ok(broadcast.includes('class="card chat-panel"'));
    assert.match(broadcast, /<h2 id="chat-title">[\s\S]*?Live chat<\/h2>/);
    assert.ok(broadcast.includes('id="m-m1"'));
    assert.ok(broadcast.includes('id="m-m2"'));
  });
});
