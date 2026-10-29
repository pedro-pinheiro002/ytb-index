/**
 * Unit tests for the Ingest pipeline steps (`src/ingest/pipeline`).
 *
 * Each step runs against an in-memory `YouTubeClient`, so these cover paging,
 * batching, skipping and row mapping without HTTP or a database. The
 * end-to-end run (env, quota, writes, exit codes) stays in
 * `src/cli/ingest.test.ts`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../yt/client.ts';
import type {
  CommentThread,
  ListCommentThreadsParams,
  ListPlaylistItemsParams,
  VideoResource,
  YouTubeClient,
} from '../yt/client.ts';
import type { VideoRecord } from '../shared/types.ts';
import {
  apiErrorReason,
  ChannelNotFoundError,
  collectIngestRows,
  enrichVideos,
  fetchComments,
  isQuotaExceeded,
  listUploadIds,
  resolveChannel,
  toCommentRows,
  toVideoRecord,
  type PipelineContext,
} from './pipeline.ts';

const FETCHED_AT = '2026-10-29T00:00:00.000Z';

function video(id: string, thumbnails: VideoResource['snippet']['thumbnails'] = {}): VideoResource {
  return {
    id,
    snippet: { title: `Video ${id}`, description: '', publishedAt: FETCHED_AT, thumbnails },
    contentDetails: { duration: 'PT1M' },
    statistics: { viewCount: '10', likeCount: 'n/a' },
  };
}

function thread(id: string, text: string): CommentThread {
  return {
    id,
    snippet: {
      topLevelComment: {
        id,
        snippet: { authorDisplayName: 'a', textOriginal: text, publishedAt: FETCHED_AT },
      },
    },
  };
}

function googleError(code: number, reason: string): ApiError {
  return new ApiError(code, { error: { code, errors: [{ reason }] } });
}

/** A client whose methods fail unless a test overrides them. */
function client(overrides: Partial<YouTubeClient>): YouTubeClient {
  const unexpected = async (): Promise<never> => {
    throw new Error('unexpected call');
  };
  return {
    listChannel: unexpected,
    listPlaylistItems: unexpected,
    listVideos: unexpected,
    listCommentThreads: unexpected,
    ...overrides,
  };
}

/** A context that records call labels and log lines. */
function context(overrides: Partial<YouTubeClient>, verbose = false) {
  const calls: string[] = [];
  const logs: string[] = [];
  const ctx: PipelineContext = {
    client: client(overrides),
    call: async (label, run) => {
      calls.push(label);
      return run();
    },
    log: (message) => logs.push(message),
    verbose,
    fetchedAt: FETCHED_AT,
  };
  return { ctx, calls, logs };
}

describe('resolveChannel', () => {
  it('looks up a handle with forHandle and maps the Channel', async () => {
    let params: unknown;
    const { ctx, calls } = context({
      listChannel: async (p) => {
        params = p;
        return {
          items: [
            {
              id: 'UC1',
              snippet: { title: 'Chan' },
              contentDetails: { relatedPlaylists: { uploads: 'UU1' } },
            },
          ],
        };
      },
    });
    const channel = await resolveChannel(ctx, { kind: 'handle', value: 'chan' });
    assert.deepEqual(params, { forHandle: 'chan' });
    assert.deepEqual(channel, {
      id: 'UC1',
      title: 'Chan',
      uploadsPlaylistId: 'UU1',
      fetchedAt: FETCHED_AT,
    });
    assert.deepEqual(calls, ['channels.list']);
  });

  it('throws ChannelNotFoundError when no channel matches', async () => {
    const { ctx } = context({ listChannel: async () => ({ items: [] }) });
    await assert.rejects(resolveChannel(ctx, { kind: 'id', value: 'UCx' }), ChannelNotFoundError);
  });
});

describe('listUploadIds', () => {
  it('follows nextPageToken and drops items without a video id', async () => {
    const pages: ListPlaylistItemsParams[] = [];
    const { ctx, calls } = context({
      listPlaylistItems: async (params) => {
        pages.push(params);
        const item = (videoId: string) => ({
          id: videoId,
          snippet: { title: '', publishedAt: FETCHED_AT, resourceId: { videoId } },
        });
        return params.pageToken === undefined
          ? { items: [item('v1'), item('')], nextPageToken: 'p2' }
          : { items: [item('v2')] };
      },
    });
    assert.deepEqual(await listUploadIds(ctx, 'UU1'), ['v1', 'v2']);
    assert.equal(pages[1]?.pageToken, 'p2');
    assert.equal(calls.length, 2);
  });
});

describe('enrichVideos', () => {
  it('batches ids by 50, one call per batch', async () => {
    const batches: number[] = [];
    const { ctx } = context({
      listVideos: async ({ id }) => {
        batches.push(id.length);
        return { items: id.map((videoId) => video(videoId)) };
      },
    });
    const ids = Array.from({ length: 120 }, (_, index) => `v${index}`);
    const videos = await enrichVideos(ctx, ids, 'UC1');
    assert.deepEqual(batches, [50, 50, 20]);
    assert.equal(videos.length, 120);
    assert.equal(videos[0]?.channelId, 'UC1');
  });
});

describe('toVideoRecord', () => {
  it('picks the best thumbnail and coerces counts', () => {
    const record = toVideoRecord(
      video('v1', { default: { url: 'd' }, high: { url: 'h' } }),
      'UC1',
      FETCHED_AT,
    );
    assert.equal(record.thumbnailUrl, 'h');
    assert.equal(record.viewCount, 10);
    assert.equal(record.likeCount, 0);
    assert.equal(record.commentCount, 0);
  });

  it('falls back to the hqdefault URL without thumbnails', () => {
    const record = toVideoRecord(video('v1'), 'UC1', FETCHED_AT);
    assert.equal(record.thumbnailUrl, 'https://i.ytimg.com/vi/v1/hqdefault.jpg');
  });
});

describe('fetchComments', () => {
  const videos = [{ id: 'v1' }, { id: 'v2' }, { id: 'v3' }] as VideoRecord[];

  it('pages each video and skips commentsDisabled / videoNotFound', async () => {
    const { ctx, logs } = context({
      listCommentThreads: async ({ videoId, pageToken }: ListCommentThreadsParams) => {
        if (videoId === 'v2') throw googleError(403, 'commentsDisabled');
        if (videoId === 'v3') throw googleError(404, 'videoNotFound');
        return pageToken === undefined
          ? { items: [thread('c1', 'a')], nextPageToken: 'p2' }
          : { items: [thread('c2', 'b')] };
      },
    });
    const raw = await fetchComments(ctx, videos);
    assert.deepEqual(
      raw.map((entry) => [entry.videoId, entry.comment.id]),
      [
        ['v1', 'c1'],
        ['v1', 'c2'],
      ],
    );
    assert.deepEqual(logs, ['[skip] v2: commentsDisabled', '[skip] v3: videoNotFound']);
  });

  it('rethrows any other API error', async () => {
    const { ctx } = context({
      listCommentThreads: async () => {
        throw googleError(403, 'quotaExceeded');
      },
    });
    await assert.rejects(fetchComments(ctx, videos), ApiError);
  });

  it('logs per-video counts under verbose', async () => {
    const { ctx, logs } = context({ listCommentThreads: async () => ({ items: [] }) }, true);
    await fetchComments(ctx, [{ id: 'v1' }] as VideoRecord[]);
    assert.match(logs[0] ?? '', /^\[video\] v1 comments=0 \(\d+ms\)$/);
  });
});

describe('toCommentRows', () => {
  it('maps comments, extracts TimeAnchors and sets hasAnchors', () => {
    const raw = [
      { videoId: 'v1', comment: thread('c1', 'see 1:02:03').snippet.topLevelComment },
      { videoId: 'v1', comment: thread('c2', 'no time here').snippet.topLevelComment },
    ];
    const { comments, anchors } = toCommentRows(raw, 'UC1', FETCHED_AT);
    assert.deepEqual(
      comments.map((comment) => [comment.id, comment.hasAnchors, comment.likeCount]),
      [
        ['c1', 1, 0],
        ['c2', 0, 0],
      ],
    );
    assert.deepEqual(anchors, [
      { commentId: 'c1', seconds: 3723, rawText: '1:02:03', charPosition: 4 },
    ]);
  });
});

describe('collectIngestRows', () => {
  it('runs every step in order and reports the Channel once resolved', async () => {
    const order: string[] = [];
    const { ctx, logs } = context({
      listChannel: async () => ({
        items: [
          {
            id: 'UC1',
            snippet: { title: 'Chan' },
            contentDetails: { relatedPlaylists: { uploads: 'UU1' } },
          },
        ],
      }),
      listPlaylistItems: async () => {
        order.push('playlist');
        return {
          items: [
            { id: 'p', snippet: { title: '', publishedAt: '', resourceId: { videoId: 'v1' } } },
          ],
        };
      },
      listVideos: async () => ({ items: [video('v1')] }),
      listCommentThreads: async () => ({ items: [thread('c1', 'at 0:42')] }),
    });
    const rows = await collectIngestRows(ctx, { kind: 'id', value: 'UC1' }, async (channel) => {
      order.push(`channel ${channel.id}`);
    });
    assert.deepEqual(order, ['channel UC1', 'playlist']);
    assert.equal(rows.channel.id, 'UC1');
    assert.equal(rows.videos.length, 1);
    assert.equal(rows.comments.length, 1);
    assert.equal(rows.anchors.length, 1);
    assert.deepEqual(logs, [
      '[4/8] Resolving channel...',
      '[5/8] Fetching uploads playlist...',
      '[6/8] Enriching 1 videos...',
      '[7/8] Fetching comments for 1 videos...',
      '[8/8] Detecting timestamps and persisting...',
    ]);
  });
});

describe('Google error inspection', () => {
  it('reads the first reason and recognizes 403 quotaExceeded only', () => {
    assert.equal(apiErrorReason(googleError(403, 'commentsDisabled')), 'commentsDisabled');
    assert.equal(apiErrorReason(new Error('x')), undefined);
    assert.equal(isQuotaExceeded(googleError(403, 'quotaExceeded')), true);
    assert.equal(isQuotaExceeded(googleError(400, 'quotaExceeded')), false);
  });
});
