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
  CommentListResponse,
  CommentResource,
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
import { QuotaCounter } from '../yt/quota.ts';
import { sealOperatorKey } from '../server/api/seal.ts';
import { parseIngestArgs, runIngest } from './ingest.ts';

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
  /** `comments.list` pages per `parentId`, served in order by `pageToken`. */
  replies?: Record<string, CommentListResponse[]>;
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

    if (path.endsWith('/comments')) {
      const parentId = parsed.searchParams.get('parentId') ?? '';
      const pages = config.replies?.[parentId];
      if (pages === undefined) throw new Error(`fake transport: no replies for ${parentId}`);
      const token = parsed.searchParams.get('pageToken');
      const page = pages[token === null ? 0 : Number(token)];
      if (page === undefined) throw new Error(`fake transport: no reply page ${token}`);
      return jsonResponse(page);
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

  it('uses the unsealed OperatorKey instead of YOUTUBE_API_KEY (F6 #51, ADR-0008)', async () => {
    const operatorKey = `AIza${'o'.repeat(35)}`;
    const pair = await crypto.subtle.generateKey(
      {
        name: 'RSA-OAEP',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['encrypt', 'decrypt'],
    );
    const publicJwk = JSON.stringify(await crypto.subtle.exportKey('jwk', pair.publicKey));
    process.env['INGEST_SEALED_KEY'] = await sealOperatorKey(operatorKey, publicJwk);
    process.env['INGEST_SEAL_PRIVATE_KEY'] = JSON.stringify(
      await crypto.subtle.exportKey('jwk', pair.privateKey),
    );
    try {
      const { transport, calls } = makeTransport({
        channel: CHANNEL,
        playlistPages: [PLAYLIST_PAGE],
        videos: VIDEOS,
        comments: COMMENTS,
      });
      const code = await runIngest({ channel: '@test', dbPath, transport, now: FIXED_NOW });

      assert.equal(code, 0);
      assert.ok(calls.length > 0);
      for (const url of calls) {
        assert.equal(new URL(url).searchParams.get('key'), operatorKey);
      }
      assert.ok(!stdout().includes(operatorKey) && !stderr().includes(operatorKey));
    } finally {
      delete process.env['INGEST_SEALED_KEY'];
      delete process.env['INGEST_SEAL_PRIVATE_KEY'];
    }
  });

  it('exits 1 before any API call when INGEST_SEALED_KEY has no private key', async () => {
    process.env['INGEST_SEALED_KEY'] = 'v1.abc';
    try {
      const { transport, calls } = makeTransport({ channel: CHANNEL });
      const code = await runIngest({ channel: '@test', dbPath, transport });
      assert.equal(code, 1);
      assert.match(stderr(), /INGEST_SEAL_PRIVATE_KEY is not/);
      assert.equal(calls.length, 0);
    } finally {
      delete process.env['INGEST_SEALED_KEY'];
    }
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

  it('--report-status without --remote exits 1 before any API call', async () => {
    const { transport, calls } = makeTransport({
      channel: CHANNEL,
      playlistPages: [PLAYLIST_PAGE],
      videos: VIDEOS,
      comments: COMMENTS,
    });

    const code = await runIngest({
      channel: '@test',
      reportStatus: 'req-1',
      transport,
      now: FIXED_NOW,
    });

    assert.equal(code, 1);
    assert.match(stderr(), /--report-status requires --remote/);
    assert.equal(calls.length, 0);
    assert.equal(existsSync(dbPath), false);
  });

  it('--remote --report-status reports running then done with the final counts', async () => {
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
    const { writer: statusWriter, applied: statusApplied } = fakeWriter();

    const code = await runIngest({
      channel: '@test',
      remote: true,
      reportStatus: 'req-1',
      writer,
      statusWriter,
      transport,
      now: FIXED_NOW,
    });

    assert.equal(code, 0);
    // Catalog write is unchanged: one apply with all seven statements.
    assert.equal(applied.length, 1);
    assert.equal(applied[0]!.length, 7);
    // Status lifecycle: running (with resolved channel id) → done (counts).
    assert.equal(statusApplied.length, 2);
    const running = statusApplied[0]![0]!;
    assert.match(running.sql, /status = 'running'/);
    assert.deepEqual(running.params, [CHANNEL.id, '2024-03-01T00:00:00.000Z', 'req-1']);
    const done = statusApplied[1]![0]!;
    assert.match(done.sql, /status = 'done'/);
    assert.match(done.sql, /finished_at = \?/);
    // videos, comments, replies, skipped_videos, quota_used (5 calls).
    assert.deepEqual(done.params, [
      2,
      2,
      0,
      0,
      5,
      '2024-03-01T00:00:00.000Z',
      '2024-03-01T00:00:00.000Z',
      'req-1',
    ]);
    assert.match(stdout(), /channels=1 videos=2 comments=2 anchors=2 duration=\d/);
    assert.equal(existsSync(dbPath), false);
  });

  it('--remote --report-status marks the request failed when the pipeline fails', async () => {
    process.env['CLOUDFLARE_API_TOKEN'] = 'test-token';
    process.env['CLOUDFLARE_ACCOUNT_ID'] = 'test-account';
    process.env['D1_DATABASE_ID'] = 'test-db';
    const { transport } = makeTransport({
      channel: CHANNEL,
      playlistPages: [PLAYLIST_PAGE],
      videos: VIDEOS,
      comments: COMMENTS,
    });
    // Fail after the run is reported running: quota exhaustion while fetching
    // comments (step 8).
    const quotaTransport: Transport = async (url) => {
      if (new URL(url).pathname.endsWith('/commentThreads')) {
        return apiErrorResponse(403, 'quotaExceeded', 'quota exceeded');
      }
      return transport(url);
    };
    const { writer, applied } = fakeWriter();
    const { writer: statusWriter, applied: statusApplied } = fakeWriter();

    const code = await runIngest({
      channel: '@test',
      remote: true,
      reportStatus: 'req-1',
      writer,
      statusWriter,
      transport: quotaTransport,
      now: FIXED_NOW,
    });

    assert.equal(code, 2);
    // Nothing was persisted; the failure is still reported.
    assert.equal(applied.length, 0);
    assert.equal(statusApplied.length, 2);
    assert.match(statusApplied[0]![0]!.sql, /status = 'running'/);
    const failed = statusApplied[1]![0]!;
    assert.match(failed.sql, /status = 'failed'/);
    assert.match(failed.sql, /finished_at = \?/);
    const params = failed.params as unknown[];
    assert.match(params[0] as string, /quota exceeded/i);
    assert.equal(params[1], '2024-03-01T00:00:00.000Z');
    assert.equal(params[2], '2024-03-01T00:00:00.000Z');
    // quota_used: channels + playlistItems + videos billed before the failure.
    assert.match(failed.sql, /quota_used = \?/);
    assert.equal(params[3], 3);
    assert.equal(params[4], 'req-1');
  });

  it('--remote --report-status keeps the ingest running when status updates fail', async () => {
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
    const statusWriter: D1RestWriter = {
      apply: async () => {
        throw new Error('D1 HTTP request failed after 5 attempts');
      },
    };

    const code = await runIngest({
      channel: '@test',
      remote: true,
      reportStatus: 'req-1',
      writer,
      statusWriter,
      transport,
      now: FIXED_NOW,
    });

    assert.equal(code, 0);
    assert.equal(applied.length, 1);
    assert.match(stdout(), /channels=1 videos=2 comments=2 anchors=2 duration=\d/);
    assert.match(stderr(), /\[WARN\] status update for ingest request req-1 failed/);
  });

  it('--remote --report-status marks the request failed on a pre-start API key failure', async () => {
    // No D1 env vars: the injected `writer` doubles as the status-writer
    // fallback, and the reporter still covers the step-1 failure.
    process.env['YOUTUBE_API_KEY'] = '';
    const { transport, calls } = makeTransport({});
    const { writer, applied } = fakeWriter();

    const code = await runIngest({
      channel: '@test',
      remote: true,
      reportStatus: 'req-1',
      writer,
      transport,
      now: FIXED_NOW,
    });

    assert.equal(code, 1);
    assert.match(stderr(), /YOUTUBE_API_KEY is not set/);
    assert.doesNotMatch(stderr(), /--report-status disabled/);
    assert.equal(calls.length, 0);
    assert.equal(applied.length, 1);
    const failed = applied[0]![0]!;
    assert.match(failed.sql, /status = 'failed'/);
    const params = failed.params as unknown[];
    assert.match(params[0] as string, /YOUTUBE_API_KEY is not set/);
    assert.equal(params[1], '2024-03-01T00:00:00.000Z');
    assert.equal(params[2], '2024-03-01T00:00:00.000Z');
    assert.equal(params[3], 'req-1');
  });

  it('--remote --report-status marks the request failed on a bad channel input', async () => {
    process.env['CLOUDFLARE_API_TOKEN'] = 'test-token';
    process.env['CLOUDFLARE_ACCOUNT_ID'] = 'test-account';
    process.env['D1_DATABASE_ID'] = 'test-db';
    const { transport, calls } = makeTransport({});
    const { writer: statusWriter, applied: statusApplied } = fakeWriter();

    const code = await runIngest({
      channel: 'https://example.com/watch?v=abc',
      remote: true,
      reportStatus: 'req-1',
      statusWriter,
      transport,
      now: FIXED_NOW,
    });

    assert.equal(code, 1);
    assert.match(stderr(), /unrecognised channel input/);
    assert.equal(calls.length, 0);
    assert.equal(statusApplied.length, 1);
    const failed = statusApplied[0]![0]!;
    assert.match(failed.sql, /status = 'failed'/);
    assert.match((failed.params as unknown[])[0] as string, /unrecognised channel input/);
  });

  it('--remote --report-status warns and proceeds when the D1 env is missing', async () => {
    const { transport, calls } = makeTransport({
      channel: CHANNEL,
      playlistPages: [PLAYLIST_PAGE],
      videos: VIDEOS,
      comments: COMMENTS,
    });

    const code = await runIngest({
      channel: '@test',
      remote: true,
      reportStatus: 'req-1',
      transport,
      now: FIXED_NOW,
    });

    assert.equal(code, 1);
    assert.match(
      stderr(),
      /\[WARN\] --report-status disabled: missing CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID/,
    );
    // The run proceeds to `--remote`'s own env check; no status row was touched.
    assert.match(
      stderr(),
      /--remote requires CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID/,
    );
    assert.equal(calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// v2 fixtures: Broadcasts, Replies, authorChannelId, search_text (F3a, #49)
// ---------------------------------------------------------------------------

const V2_PLAYLIST: PlaylistItemListResponse = {
  items: ['up1', 'bc1', 'soon1', 'off1'].map((videoId) => ({
    id: `PL_${videoId}`,
    snippet: {
      title: videoId,
      publishedAt: '2024-01-01T00:00:00Z',
      resourceId: { videoId },
    },
  })),
};

function v2Video(
  id: string,
  title: string,
  extra: Partial<Pick<VideoResource, 'liveStreamingDetails'>> & {
    liveBroadcastContent?: 'none' | 'live' | 'upcoming';
  } = {},
): VideoResource {
  return {
    id,
    snippet: {
      title,
      description: 'Ação, ao VIVO!',
      publishedAt: '2024-01-01T00:00:00Z',
      channelId: CHANNEL.id,
      ...(extra.liveBroadcastContent !== undefined
        ? { liveBroadcastContent: extra.liveBroadcastContent }
        : {}),
      thumbnails: {},
    },
    contentDetails: { duration: 'PT1M' },
    statistics: { viewCount: '1', likeCount: '1', commentCount: '1' },
    ...(extra.liveStreamingDetails !== undefined
      ? { liveStreamingDetails: extra.liveStreamingDetails }
      : {}),
  };
}

const V2_VIDEOS: VideoResource[] = [
  v2Video('up1', 'Plain Upload', { liveBroadcastContent: 'none' }),
  v2Video('bc1', 'Ended Broadcast', {
    liveBroadcastContent: 'none',
    liveStreamingDetails: {
      actualStartTime: '2024-01-05T10:00:00Z',
      actualEndTime: '2024-01-05T12:00:00Z',
    },
  }),
  v2Video('soon1', 'Upcoming Broadcast', {
    liveBroadcastContent: 'upcoming',
    liveStreamingDetails: { scheduledStartTime: '2024-12-01T00:00:00Z' },
  }),
  v2Video('off1', 'Comments Off'),
];

/** A comment resource; `author` doubles as the `UC_<author>` channel id unless `null`. */
function v2Comment(
  id: string,
  author: string,
  text: string,
  parentId?: string,
  authorChannelId: string | null = `UC_${author}`,
): CommentResource {
  return {
    id,
    snippet: {
      authorDisplayName: author,
      ...(authorChannelId !== null ? { authorChannelId: { value: authorChannelId } } : {}),
      textOriginal: text,
      publishedAt: '2024-02-01T00:00:00Z',
      likeCount: 1,
      ...(parentId !== undefined ? { parentId } : {}),
    },
  };
}

/** Fresh per run: a `Response` body can be read only once. */
function v2Comments(): Record<string, CommentThreadListResponse | Response> {
  return {
    // Every Reply is embedded: no comments.list call.
    up1: {
      items: [
        {
          id: 'c1',
          snippet: {
            topLevelComment: v2Comment('c1', 'alice', 'Great part at 1:23!'),
            totalReplyCount: 1,
          },
          replies: {
            comments: [v2Comment('r1', 'bob', 'Agreed, at 2:00 too', 'c1')],
          },
        },
      ],
    },
    // 3 Replies, 1 embedded: page comments.list (2 pages) and use those instead.
    // The top-level author has no channel id (legacy account).
    bc1: {
      items: [
        {
          id: 'c2',
          snippet: {
            topLevelComment: v2Comment('c2', 'carol', 'Live was fun', undefined, null),
            totalReplyCount: 3,
          },
          replies: { comments: [v2Comment('r2', 'dan', 'embedded only', 'c2')] },
        },
      ],
    },
    off1: apiErrorResponse(403, 'commentsDisabled', 'comments are disabled'),
  };
}

const V2_REPLIES: Record<string, CommentListResponse[]> = {
  c2: [
    {
      items: [v2Comment('r2', 'dan', 'Yes at 10:00', 'c2'), v2Comment('r3', 'erin', 'Café', 'c2')],
      nextPageToken: '1',
    },
    // No `parentId` on the resource: the thread still names the parent.
    { items: [v2Comment('r4', 'fay', 'same')] },
  ],
};

function v2Transport(): { transport: Transport; calls: string[] } {
  return makeTransport({
    channel: CHANNEL,
    playlistPages: [V2_PLAYLIST],
    videos: V2_VIDEOS,
    comments: v2Comments(),
    replies: V2_REPLIES,
  });
}

/** The bound value of column `name` in an INSERT statement. */
function paramOf(statement: Statement, name: string): unknown {
  const columns = /\(([^)]*)\)\s*VALUES/s
    .exec(statement.sql)![1]!
    .split(',')
    .map((column) => column.trim());
  const index = columns.indexOf(name);
  assert.ok(index >= 0, `column ${name} not in ${statement.sql}`);
  return (statement.params as unknown[])[index];
}

describe('runIngest v2: Broadcasts and Replies (F3a)', () => {
  it('classifies Broadcasts, skips upcoming ones, pages Replies and bills quota', async () => {
    process.env['CLOUDFLARE_API_TOKEN'] = 'test-token';
    process.env['CLOUDFLARE_ACCOUNT_ID'] = 'test-account';
    process.env['D1_DATABASE_ID'] = 'test-db';
    const { transport, calls } = v2Transport();
    const { writer, applied } = fakeWriter();
    const quota = new QuotaCounter();

    const code = await runIngest({
      channel: '@test',
      remote: true,
      writer,
      transport,
      quota,
      now: FIXED_NOW,
    });

    assert.equal(code, 0, stderr());
    // channels + playlistItems + videos + commentThreads ×2 (up1, bc1; the failed
    // off1 call is not billed, as in v1) + comments.list ×2 (c2's Replies).
    // Nothing at all for the upcoming Broadcast.
    assert.equal(quota.total, 7);
    assert.equal(calls.filter((url) => url.includes('videoId=soon1')).length, 0);
    assert.equal(calls.filter((url) => new URL(url).pathname.endsWith('/comments')).length, 2);
    assert.match(stdout(), /\[skip\] soon1: upcoming Broadcast/);
    assert.match(stdout(), /\[skip\] off1: commentsDisabled/);

    const statements = applied[0]!;
    const videos = statements.filter((s) => /INSERT INTO videos/.test(s.sql));
    assert.deepEqual(
      videos.map((s) => [
        paramOf(s, 'id'),
        paramOf(s, 'kind'),
        paramOf(s, 'broadcast_state'),
        paramOf(s, 'actual_start_time'),
        paramOf(s, 'actual_end_time'),
        paramOf(s, 'search_text'),
      ]),
      [
        ['up1', 'upload', null, null, null, 'plain upload acao ao vivo'],
        [
          'bc1',
          'broadcast',
          'ended',
          '2024-01-05T10:00:00Z',
          '2024-01-05T12:00:00Z',
          'ended broadcast acao ao vivo',
        ],
        ['off1', 'upload', null, null, null, 'comments off acao ao vivo'],
      ],
    );

    const comments = statements.filter((s) => /INSERT INTO comments/.test(s.sql));
    assert.deepEqual(
      comments.map((s) => [
        paramOf(s, 'id'),
        paramOf(s, 'parent_id'),
        paramOf(s, 'author_channel_id'),
        paramOf(s, 'search_text'),
        paramOf(s, 'has_anchors'),
      ]),
      [
        // Top-level CommentRecords first, then Replies (FK order).
        ['c1', null, 'UC_alice', 'great part at 1 23', 1],
        ['c2', null, '', 'live was fun', 0],
        ['r1', 'c1', 'UC_bob', 'agreed at 2 00 too', 1],
        ['r2', 'c2', 'UC_dan', 'yes at 10 00', 1],
        ['r3', 'c2', 'UC_erin', 'cafe', 0],
        ['r4', 'c2', 'UC_fay', 'same', 0],
      ],
    );
    // Replies get TimeAnchor detection like top-level CommentRecords.
    const anchors = statements.filter((s) => /INSERT INTO time_anchors/.test(s.sql));
    assert.deepEqual(
      anchors.map((s) => [paramOf(s, 'comment_id'), paramOf(s, 'seconds')]),
      [
        ['c1', 83],
        ['r1', 120],
        ['r2', 600],
      ],
    );
    // Every comment statement precedes every anchor statement.
    assert.ok(statements.indexOf(anchors[0]!) > statements.indexOf(comments.at(-1)!));

    assert.match(
      stdout(),
      /channels=1 videos=3 comments=2 anchors=3 duration=\d+\.\ds quota=7 replies=4 skipped=1/,
    );
  });

  it('persists Broadcasts and Replies into the local SQLite Catalog', async () => {
    const { transport } = v2Transport();

    const code = await runIngest({
      channel: '@test',
      dbPath,
      transport,
      now: FIXED_NOW,
    });

    assert.equal(code, 0, stderr());
    const db = await openCatalog(dbPath);
    try {
      assert.deepEqual(
        await db.all(
          'SELECT id, kind, broadcast_state, actual_start_time, actual_end_time, search_text ' +
            'FROM videos ORDER BY id',
        ),
        [
          {
            id: 'bc1',
            kind: 'broadcast',
            broadcast_state: 'ended',
            actual_start_time: '2024-01-05T10:00:00Z',
            actual_end_time: '2024-01-05T12:00:00Z',
            search_text: 'ended broadcast acao ao vivo',
          },
          {
            id: 'off1',
            kind: 'upload',
            broadcast_state: null,
            actual_start_time: null,
            actual_end_time: null,
            search_text: 'comments off acao ao vivo',
          },
          {
            id: 'up1',
            kind: 'upload',
            broadcast_state: null,
            actual_start_time: null,
            actual_end_time: null,
            search_text: 'plain upload acao ao vivo',
          },
        ],
      );
      // The v2 columns read back through `comments_active`. FIXED_NOW is long
      // past, so the view redacts search_text; the raw column holds it.
      assert.deepEqual(
        await db.all('SELECT id, parent_id, author_channel_id FROM comments_active ORDER BY id'),
        [
          { id: 'c1', parent_id: null, author_channel_id: 'UC_alice' },
          { id: 'c2', parent_id: null, author_channel_id: '' },
          { id: 'r1', parent_id: 'c1', author_channel_id: 'UC_bob' },
          { id: 'r2', parent_id: 'c2', author_channel_id: 'UC_dan' },
          { id: 'r3', parent_id: 'c2', author_channel_id: 'UC_erin' },
          { id: 'r4', parent_id: 'c2', author_channel_id: 'UC_fay' },
        ],
      );
      assert.deepEqual(
        await db.all("SELECT id, search_text FROM comments WHERE id IN ('r3', 'c1') ORDER BY id"),
        [
          { id: 'c1', search_text: 'great part at 1 23' },
          { id: 'r3', search_text: 'cafe' },
        ],
      );
      assert.equal((await db.get<{ c: number }>('SELECT count(*) AS c FROM time_anchors'))?.c, 3);
    } finally {
      db.close();
    }
  });

  it('reports replies_written, skipped_videos and quota_used with done', async () => {
    process.env['CLOUDFLARE_API_TOKEN'] = 'test-token';
    process.env['CLOUDFLARE_ACCOUNT_ID'] = 'test-account';
    process.env['D1_DATABASE_ID'] = 'test-db';
    const { transport } = v2Transport();
    const { writer } = fakeWriter();
    const { writer: statusWriter, applied: statusApplied } = fakeWriter();

    const code = await runIngest({
      channel: '@test',
      remote: true,
      reportStatus: 'req-9',
      writer,
      statusWriter,
      transport,
      now: FIXED_NOW,
    });

    assert.equal(code, 0, stderr());
    const done = statusApplied.at(-1)![0]!;
    assert.match(done.sql, /status = 'done'/);
    assert.match(
      done.sql,
      /comments_written = \?, replies_written = \?, skipped_videos = \?, quota_used = \?/,
    );
    // videos, comments (top-level only), replies, skipped, quota.
    assert.deepEqual(done.params, [
      3,
      2,
      4,
      1,
      7,
      '2024-03-01T00:00:00.000Z',
      '2024-03-01T00:00:00.000Z',
      'req-9',
    ]);
  });
});
describe('parseIngestArgs', () => {
  it('parses the channel, --remote, and a --report-status value', () => {
    assert.deepEqual(parseIngestArgs(['@test', '--remote', '--report-status', 'req-1']), {
      channel: '@test',
      verbose: false,
      remote: true,
      reportStatus: 'req-1',
    });
  });

  it('accepts the inline --report-status=<id> form and any flag order', () => {
    assert.deepEqual(parseIngestArgs(['--report-status=req-2', '@test', '--verbose', '--remote']), {
      channel: '@test',
      verbose: true,
      remote: true,
      reportStatus: 'req-2',
    });
  });

  it('does not mistake the --report-status value for the channel', () => {
    const parsed = parseIngestArgs(['--remote', '--report-status', 'req-3']);
    assert.equal(parsed.channel, undefined);
    assert.equal(parsed.reportStatus, 'req-3');
  });

  it('errors when --report-status has no value', () => {
    assert.deepEqual(parseIngestArgs(['@test', '--remote', '--report-status']), {
      channel: '@test',
      verbose: false,
      remote: true,
      error: '--report-status requires a <requestId> value.',
    });
  });

  it('errors on an empty --report-status= value', () => {
    const parsed = parseIngestArgs(['@test', '--remote', '--report-status=']);
    assert.equal(parsed.error, '--report-status requires a <requestId> value.');
  });

  it('errors when --report-status is given without --remote', () => {
    assert.equal(
      parseIngestArgs(['@test', '--report-status', 'req-4']).error,
      '--report-status requires --remote.',
    );
  });

  it('keeps the existing behavior of ignoring unknown flags', () => {
    assert.deepEqual(parseIngestArgs(['--verbose', '@test', '--unknown']), {
      channel: '@test',
      verbose: true,
      remote: false,
    });
  });
});
