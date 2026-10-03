/**
 * End-to-end tests for `runIngest` (#19 / T06).
 *
 * Everything runs against a fake `transport` (the YouTube seam), a fake
 * `D1RestWriter` for `--remote`, and an in-memory SQLite database — no
 * network, no real files.
 *
 * `runIngest` opens *and closes* its own connection, so plain `:memory:` would
 * be gone by the time we assert on rows. Each test therefore uses a throwaway
 * on-disk catalog under the OS temp dir, which is removed in `afterEach`.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CommentThread,
  CommentThreadListResponse,
  PlaylistItemListResponse,
  Transport,
  VideoResource,
} from '../yt/client.ts';
import { openCatalog } from '../db/sqlite.ts';
import type { D1RestWriter } from '../db/d1-http.ts';
import type { Statement } from '../db/executor.ts';
import { API_KEY_FAILURE_MESSAGES } from '../yt/api-key.ts';
import { runIngest } from './ingest.ts';

// A valid-shape key: `AIza` + 35 URL-safe chars.
const VALID_KEY = `AIza${'x'.repeat(35)}`;

/** Env vars `--remote` requires; kept empty across tests by default. */
const REMOTE_ENV_VARS = [
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'D1_DATABASE_ID',
] as const;

// ---------------------------------------------------------------------------
// Captured stdout / stderr + shared in-memory DB
// ---------------------------------------------------------------------------

let tempDir: string;
let dbPath: string;
let outChunks: string[];
let errChunks: string[];
let originalOut: typeof process.stdout.write;
let originalErr: typeof process.stderr.write;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'ytb-ingest-'));
  dbPath = join(tempDir, 'catalog.sqlite');

  outChunks = [];
  errChunks = [];
  originalOut = process.stdout.write;
  originalErr = process.stderr.write;
  process.stdout.write = ((chunk: unknown) => {
    outChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    errChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  process.env['YOUTUBE_API_KEY'] = VALID_KEY;
  for (const name of REMOTE_ENV_VARS) delete process.env[name];
});

afterEach(() => {
  process.stdout.write = originalOut;
  process.stderr.write = originalErr;
  rmSync(tempDir, { recursive: true, force: true });
  for (const name of REMOTE_ENV_VARS) delete process.env[name];
});

const stdout = (): string => outChunks.join('');
const stderr = (): string => errChunks.join('');

async function count(sql: string): Promise<number> {
  const db = await openCatalog(dbPath);
  try {
    const result = await db.get<{ c: number }>(sql);
    return result?.c ?? 0;
  } finally {
    db.close();
  }
}

async function row(sql: string): Promise<Record<string, unknown>> {
  const db = await openCatalog(dbPath);
  try {
    const result = await db.get<Record<string, unknown>>(sql);
    assert.ok(result !== undefined, `expected a row from: ${sql}`);
    return result;
  } finally {
    db.close();
  }
}

/** Fake `D1RestWriter` recording every `apply()` call. */
function fakeWriter(): { writer: D1RestWriter; applied: Statement[][] } {
  const applied: Statement[][] = [];
  return {
    writer: {
      async apply(statements) {
        applied.push(statements);
      },
    },
    applied,
  };
}

// ---------------------------------------------------------------------------
// Fake transport
// ---------------------------------------------------------------------------

interface FakeConfig {
  /** `null` / omitted simulates an unknown channel (empty `items`). */
  channel?: { id: string; title: string; uploads: string } | null;
  playlistPages?: PlaylistItemListResponse[];
  videos?: VideoResource[];
  /** Per-video comment response; a `Response` is served verbatim as an error. */
  comments?: Record<string, CommentThreadListResponse | Response>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function apiErrorResponse(code: number, reason: string, message = 'api error'): Response {
  return jsonResponse(
    {
      error: {
        code,
        message,
        errors: [{ message, domain: 'youtube.commentThread', reason }],
        status: 'PERMISSION_DENIED',
      },
    },
    code,
  );
}

function makeTransport(config: FakeConfig): { transport: Transport; calls: string[] } {
  const calls: string[] = [];
  let playlistIndex = 0;

  const transport: Transport = async (url) => {
    calls.push(url);
    const parsed = new URL(url);
    const path = parsed.pathname;

    if (path.endsWith('/channels')) {
      const items = config.channel
        ? [
            {
              id: config.channel.id,
              snippet: { title: config.channel.title },
              contentDetails: { relatedPlaylists: { uploads: config.channel.uploads } },
            },
          ]
        : [];
      return jsonResponse({ items });
    }

    if (path.endsWith('/playlistItems')) {
      const page = (config.playlistPages ?? [])[playlistIndex];
      playlistIndex += 1;
      if (page === undefined) throw new Error('fake transport: playlist pages exhausted');
      return jsonResponse(page);
    }

    if (path.endsWith('/videos')) {
      return jsonResponse({ items: config.videos ?? [] });
    }

    if (path.endsWith('/commentThreads')) {
      const videoId = parsed.searchParams.get('videoId') ?? '';
      const entry = config.comments?.[videoId];
      if (entry === undefined) {
        throw new Error(`fake transport: no comment response for ${videoId}`);
      }
      return entry instanceof Response ? entry : jsonResponse(entry);
    }

    throw new Error(`fake transport: unexpected URL ${url}`);
  };

  return { transport, calls };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CHANNEL = { id: 'UC_test_channel', title: 'Test Channel', uploads: 'UU_test_channel' };

const PLAYLIST_PAGE: PlaylistItemListResponse = {
  items: [
    {
      id: 'PL1',
      snippet: {
        title: 'Video One',
        publishedAt: '2024-01-01T00:00:00Z',
        resourceId: { videoId: 'vid1' },
      },
    },
    {
      id: 'PL2',
      snippet: {
        title: 'Video Two',
        publishedAt: '2024-01-02T00:00:00Z',
        resourceId: { videoId: 'vid2' },
      },
    },
  ],
};

const VIDEOS: VideoResource[] = [
  {
    id: 'vid1',
    snippet: {
      title: 'Video One',
      description: '',
      publishedAt: '2024-01-01T00:00:00Z',
      channelId: CHANNEL.id,
      thumbnails: { high: { url: 'https://i.ytimg.com/vi/vid1/hqdefault.jpg' } },
    },
    contentDetails: { duration: 'PT1M' },
    statistics: { viewCount: '10', likeCount: '1', commentCount: '1' },
  },
  {
    id: 'vid2',
    snippet: {
      title: 'Video Two',
      description: '',
      publishedAt: '2024-01-02T00:00:00Z',
      channelId: CHANNEL.id,
      thumbnails: { high: { url: 'https://i.ytimg.com/vi/vid2/hqdefault.jpg' } },
    },
    contentDetails: { duration: 'PT2M' },
    statistics: { viewCount: '20', likeCount: '2', commentCount: '1' },
  },
];

function thread(id: string, commentId: string, author: string, text: string): CommentThread {
  return {
    id,
    snippet: {
      topLevelComment: {
        id: commentId,
        snippet: {
          authorDisplayName: author,
          textOriginal: text,
          publishedAt: '2024-02-01T00:00:00Z',
          likeCount: 3,
        },
      },
    },
  };
}

/** One top-level comment per video; both carry a detectable timestamp. */
const COMMENTS: Record<string, CommentThreadListResponse> = {
  vid1: { items: [thread('t1', 'c1', 'Alice', 'great part at 1:23')] },
  vid2: { items: [thread('t2', 'c2', 'Bob', 'jump to 5:32 is the best')] },
};

const FIXED_NOW = (): Date => new Date('2024-03-01T00:00:00Z');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runIngest', () => {
  it('ingests a channel, its videos, comments and anchors (happy path)', async () => {
    const { transport } = makeTransport({
      channel: CHANNEL,
      playlistPages: [PLAYLIST_PAGE],
      videos: VIDEOS,
      comments: COMMENTS,
    });

    const code = await runIngest({
      channel: '@test',
      dbPath,
      transport,
      now: FIXED_NOW,
    });

    assert.equal(code, 0);

    // DB rows.
    assert.equal(await count('SELECT count(*) AS c FROM channels'), 1);
    assert.equal(await count('SELECT count(*) AS c FROM videos'), 2);
    assert.equal(await count('SELECT count(*) AS c FROM comments'), 2);
    assert.equal(await count('SELECT count(*) AS c FROM time_anchors'), 2);
    assert.equal(await count('SELECT count(*) AS c FROM comments WHERE has_anchors = 1'), 2);

    assert.deepEqual(await row('SELECT id, title FROM channels'), {
      id: CHANNEL.id,
      title: CHANNEL.title,
    });
    assert.equal(
      (await row('SELECT fetched_at FROM channels'))['fetched_at'],
      '2024-03-01T00:00:00.000Z',
    );
    assert.equal(
      (await row('SELECT fetched_at FROM videos LIMIT 1'))['fetched_at'],
      '2024-03-01T00:00:00.000Z',
    );

    // Summary line.
    assert.match(stdout(), /channels=1 videos=2 comments=2 anchors=2 duration=\d/);

    // Non-verbose runs do not emit per-call lines.
    assert.doesNotMatch(stdout(), /\[call\]/);
  });

  it('skips a video with commentsDisabled and still ingests the rest (exit 0)', async () => {
    const { transport } = makeTransport({
      channel: CHANNEL,
      playlistPages: [PLAYLIST_PAGE],
      videos: VIDEOS,
      comments: {
        vid1: apiErrorResponse(403, 'commentsDisabled', 'comments are disabled'),
        vid2: COMMENTS['vid2']!,
      },
    });

    const code = await runIngest({ channel: '@test', dbPath, transport, now: FIXED_NOW });

    assert.equal(code, 0);
    assert.equal(await count('SELECT count(*) AS c FROM videos'), 2);
    // Only vid2's comment survived.
    assert.equal(await count('SELECT count(*) AS c FROM comments'), 1);
    assert.deepEqual(await row('SELECT id, video_id FROM comments'), {
      id: 'c2',
      video_id: 'vid2',
    });
    assert.match(stdout(), /\[skip\] vid1: commentsDisabled/);
  });

  it('exits 2 and rolls back when the API reports quotaExceeded', async () => {
    const { transport } = makeTransport({
      channel: CHANNEL,
      playlistPages: [PLAYLIST_PAGE],
      videos: VIDEOS,
      comments: COMMENTS,
    });
    // Fail on the very first call (channel resolve).
    const quotaTransport: Transport = async (url) => {
      if (new URL(url).pathname.endsWith('/channels')) {
        return apiErrorResponse(403, 'quotaExceeded', 'quota exceeded');
      }
      return transport(url);
    };

    const code = await runIngest({ channel: '@test', dbPath, transport: quotaTransport });

    assert.equal(code, 2);
    assert.match(stderr(), /quota exhausted/);
    // Nothing persisted: no batch ran.
    assert.equal(await count('SELECT count(*) AS c FROM channels'), 0);
  });

  it('exits 1 with the spec message when YOUTUBE_API_KEY is missing', async () => {
    process.env['YOUTUBE_API_KEY'] = '';

    const code = await runIngest({ channel: '@test', dbPath });

    assert.equal(code, 1);
    assert.match(
      stderr(),
      new RegExp(API_KEY_FAILURE_MESSAGES.missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
  });

  it('exits 1 with the spec message when YOUTUBE_API_KEY is malformed', async () => {
    process.env['YOUTUBE_API_KEY'] = 'wrong';

    const code = await runIngest({ channel: '@test', dbPath });

    assert.equal(code, 1);
    assert.match(
      stderr(),
      new RegExp(API_KEY_FAILURE_MESSAGES.malformed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
  });

  it('prints per-call lines on stdout when --verbose is set', async () => {
    const { transport } = makeTransport({
      channel: CHANNEL,
      playlistPages: [PLAYLIST_PAGE],
      videos: VIDEOS,
      comments: COMMENTS,
    });

    const code = await runIngest({
      channel: '@test',
      verbose: true,
      dbPath,
      transport,
      now: FIXED_NOW,
    });

    assert.equal(code, 0);
    assert.match(stdout(), /\[call\] channels\.list/);
    assert.match(stdout(), /\[call\] playlistItems\.list/);
    assert.match(stdout(), /\[video\] vid1 comments=1/);
  });

  it('--remote exits 1 listing the missing env vars, before any API call', async () => {
    const { transport, calls } = makeTransport({
      channel: CHANNEL,
      playlistPages: [PLAYLIST_PAGE],
      videos: VIDEOS,
      comments: COMMENTS,
    });

    const code = await runIngest({ channel: '@test', remote: true, transport, now: FIXED_NOW });

    assert.equal(code, 1);
    assert.match(
      stderr(),
      /--remote requires CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID/,
    );
    assert.equal(calls.length, 0);
    assert.doesNotMatch(stdout(), /\[4\/8\]/);
    assert.equal(existsSync(dbPath), false);
  });

  it('--remote writes through the D1 writer and skips the local database', async () => {
    process.env['CLOUDFLARE_API_TOKEN'] = 'test-token';
    process.env['CLOUDFLARE_ACCOUNT_ID'] = 'test-account';
    process.env['D1_DATABASE_ID'] = 'test-db';
    const { transport } = makeTransport({
      channel: CHANNEL,
      playlistPages: [PLAYLIST_PAGE],
      videos: VIDEOS,
      comments: COMMENTS,
    });
    const { writer, applied } = fakeWriter();

    const code = await runIngest({
      channel: '@test',
      remote: true,
      writer,
      transport,
      now: FIXED_NOW,
    });

    assert.equal(code, 0);
    assert.equal(applied.length, 1);
    const statements = applied[0]!;
    // channel + 2 videos + 2 comments + 2 anchors, in FK order.
    assert.equal(statements.length, 7);
    assert.match(statements[0]!.sql, /INSERT INTO channels/);
    assert.match(statements.at(-1)!.sql, /INSERT INTO time_anchors/);
    assert.equal(existsSync(dbPath), false);
    assert.match(stdout(), /channels=1 videos=2 comments=2 anchors=2 duration=\d/);
  });

  it('--remote exits 1 when the D1 write fails', async () => {
    process.env['CLOUDFLARE_API_TOKEN'] = 'test-token';
    process.env['CLOUDFLARE_ACCOUNT_ID'] = 'test-account';
    process.env['D1_DATABASE_ID'] = 'test-db';
    const { transport } = makeTransport({
      channel: CHANNEL,
      playlistPages: [PLAYLIST_PAGE],
      videos: VIDEOS,
      comments: COMMENTS,
    });
    const writer: D1RestWriter = {
      apply: async () => {
        throw new Error('D1 HTTP API rejected the batch: invalid token');
      },
    };

    const code = await runIngest({
      channel: '@test',
      remote: true,
      writer,
      transport,
      now: FIXED_NOW,
    });

    assert.equal(code, 1);
    assert.match(stderr(), /D1 HTTP API rejected the batch: invalid token/);
    assert.equal(existsSync(dbPath), false);
  });
});
