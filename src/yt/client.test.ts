/**
 * Unit tests for `createYouTubeClient` (wayfinder #18 / T05).
 *
 * Everything runs against a scripted fake `transport` (the single seam); no
 * network, no real timers. Retry backoff uses an injected no-op `sleep`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ApiError,
  UsageError,
  createYouTubeClient,
  type RetryOptions,
  type Transport,
} from './client.ts';

const API_KEY = 'AIzaTEST';

const noSleep = async (): Promise<void> => {};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type Step = () => Response | Promise<Response>;

/** Scripted transport: serves the given steps in order and records URLs. */
function scriptedTransport(steps: Step[]): { transport: Transport; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const transport: Transport = async (url) => {
    calls.push(url);
    const step = steps[i++];
    if (!step) throw new Error('scriptedTransport exhausted');
    return step();
  };
  return { transport, calls };
}

function firstUrl(calls: string[]): string {
  const url = calls[0];
  assert.ok(url !== undefined, 'expected at least one transport call');
  return url;
}

function makeClient(transport: Transport, retry?: RetryOptions) {
  return createYouTubeClient({ apiKey: API_KEY, transport, retry: { sleep: noSleep, ...retry } });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const channelEnvelope = {
  kind: 'youtube#channelListResponse',
  items: [
    {
      id: 'UCabc',
      snippet: { title: 'Test Channel' },
      contentDetails: { relatedPlaylists: { uploads: 'UUabc' } },
    },
  ],
};

const playlistItemsEnvelope = {
  kind: 'youtube#playlistItemListResponse',
  items: [
    {
      id: 'PLitem1',
      snippet: {
        title: 'Video One',
        publishedAt: '2024-01-01T00:00:00Z',
        resourceId: { kind: 'youtube#video', videoId: 'vid1' },
      },
    },
  ],
  nextPageToken: 'NEXT_PAGE',
};

const videosEnvelope = {
  kind: 'youtube#videoListResponse',
  items: [
    {
      id: 'vid1',
      snippet: { title: 'Video One', publishedAt: '2024-01-01T00:00:00Z' },
      contentDetails: { duration: 'PT1H2M3S' },
      statistics: { viewCount: '10', likeCount: '2', commentCount: '1' },
    },
  ],
};

const commentThreadsEnvelope = {
  kind: 'youtube#commentThreadListResponse',
  items: [
    {
      id: 'thread1',
      snippet: {
        topLevelComment: {
          id: 'comment1',
          snippet: {
            authorDisplayName: 'Alice',
            textOriginal: 'great bit at 1:23',
            publishedAt: '2024-02-02T00:00:00Z',
            likeCount: 4,
          },
        },
        totalReplyCount: 3,
        canReply: true,
      },
      replies: { comments: [{ id: 'reply1' }] },
    },
  ],
  nextPageToken: 'COMMENT_NEXT',
};

const quotaEnvelope = {
  error: {
    code: 403,
    message: 'The request cannot be completed because you have exceeded your quota.',
    errors: [
      {
        message: 'The request cannot be completed because you have exceeded your quota.',
        domain: 'youtube.commentThread',
        reason: 'quotaExceeded',
      },
    ],
    status: 'PERMISSION_DENIED',
  },
};

const badRequestEnvelope = {
  error: {
    code: 400,
    message: 'The playlist identified with the request cannot be found.',
    errors: [
      { message: 'bad page token', domain: 'youtube.parameter', reason: 'invalidPageToken' },
    ],
    status: 'INVALID_ARGUMENT',
  },
};

const serverErrorEnvelope = {
  error: { code: 500, message: 'Backend Error', errors: [], status: 'INTERNAL' },
};

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

describe('createYouTubeClient', () => {
  it('listChannel resolves by forHandle and returns the uploads playlist id', async () => {
    const { transport, calls } = scriptedTransport([() => jsonResponse(channelEnvelope)]);
    const client = makeClient(transport);

    const result = await client.listChannel({ forHandle: '@test' });

    assert.equal(result.items.length, 1);
    assert.equal(result.items[0]?.contentDetails.relatedPlaylists.uploads, 'UUabc');

    const url = new URL(firstUrl(calls));
    assert.equal(url.pathname, '/youtube/v3/channels');
    assert.equal(url.searchParams.get('part'), 'snippet,contentDetails');
    assert.equal(url.searchParams.get('forHandle'), '@test');
    assert.equal(url.searchParams.get('id'), null);
    assert.equal(url.searchParams.get('key'), API_KEY);
  });

  it('listChannel resolves by id', async () => {
    const { transport, calls } = scriptedTransport([() => jsonResponse(channelEnvelope)]);
    const client = makeClient(transport);

    const result = await client.listChannel({ id: 'UCabc' });

    assert.equal(result.items[0]?.id, 'UCabc');
    const url = new URL(firstUrl(calls));
    assert.equal(url.searchParams.get('id'), 'UCabc');
    assert.equal(url.searchParams.get('forHandle'), null);
  });

  it('listChannel rejects when neither forHandle nor id is given', async () => {
    const { transport } = scriptedTransport([]);
    const client = makeClient(transport);

    await assert.rejects(
      () => client.listChannel({}),
      (error: unknown) => error instanceof UsageError,
    );
  });

  it('listChannel rejects when both forHandle and id are given', async () => {
    const { transport } = scriptedTransport([]);
    const client = makeClient(transport);

    await assert.rejects(
      () => client.listChannel({ forHandle: '@test', id: 'UCabc' }),
      (error: unknown) => error instanceof UsageError,
    );
  });

  it('listPlaylistItems returns items and nextPageToken with the default page size', async () => {
    const { transport, calls } = scriptedTransport([() => jsonResponse(playlistItemsEnvelope)]);
    const client = makeClient(transport);

    const result = await client.listPlaylistItems({ playlistId: 'UUabc' });

    assert.equal(result.items[0]?.snippet.resourceId.videoId, 'vid1');
    assert.equal(result.nextPageToken, 'NEXT_PAGE');

    const url = new URL(firstUrl(calls));
    assert.equal(url.pathname, '/youtube/v3/playlistItems');
    assert.equal(url.searchParams.get('part'), 'snippet');
    assert.equal(url.searchParams.get('playlistId'), 'UUabc');
    assert.equal(url.searchParams.get('maxResults'), '50');
  });

  it('listPlaylistItems forwards pageToken and maxResults overrides', async () => {
    const { transport, calls } = scriptedTransport([() => jsonResponse(playlistItemsEnvelope)]);
    const client = makeClient(transport);

    await client.listPlaylistItems({ playlistId: 'UUabc', pageToken: 'P2', maxResults: 10 });

    const url = new URL(firstUrl(calls));
    assert.equal(url.searchParams.get('pageToken'), 'P2');
    assert.equal(url.searchParams.get('maxResults'), '10');
  });

  it('listVideos returns ISO-8601 duration and statistics', async () => {
    const { transport, calls } = scriptedTransport([() => jsonResponse(videosEnvelope)]);
    const client = makeClient(transport);

    const result = await client.listVideos({ id: ['vid1', 'vid2'] });

    assert.equal(result.items[0]?.contentDetails.duration, 'PT1H2M3S');
    assert.equal(result.items[0]?.statistics?.viewCount, '10');

    const url = new URL(firstUrl(calls));
    assert.equal(url.pathname, '/youtube/v3/videos');
    assert.equal(url.searchParams.get('part'), 'snippet,contentDetails,statistics');
    assert.equal(url.searchParams.get('id'), 'vid1,vid2');
  });

  it('listVideos rejects more than 50 ids', async () => {
    const { transport } = scriptedTransport([]);
    const client = makeClient(transport);
    const tooMany = Array.from({ length: 51 }, (_, i) => `vid${i}`);

    await assert.rejects(
      () => client.listVideos({ id: tooMany }),
      (error: unknown) => error instanceof UsageError,
    );
  });

  it('listCommentThreads returns top-level comments and ignores replies', async () => {
    const { transport, calls } = scriptedTransport([() => jsonResponse(commentThreadsEnvelope)]);
    const client = makeClient(transport);

    const result = await client.listCommentThreads({ videoId: 'vid1' });

    assert.equal(
      result.items[0]?.snippet.topLevelComment.snippet.textOriginal,
      'great bit at 1:23',
    );
    assert.equal(result.nextPageToken, 'COMMENT_NEXT');

    const url = new URL(firstUrl(calls));
    assert.equal(url.pathname, '/youtube/v3/commentThreads');
    assert.equal(url.searchParams.get('part'), 'snippet');
    assert.equal(url.searchParams.get('videoId'), 'vid1');
    assert.equal(url.searchParams.get('maxResults'), '100');
  });

  it('listCommentThreads forwards pageToken', async () => {
    const { transport, calls } = scriptedTransport([() => jsonResponse(commentThreadsEnvelope)]);
    const client = makeClient(transport);

    await client.listCommentThreads({ videoId: 'vid1', pageToken: 'C2' });

    assert.equal(new URL(firstUrl(calls)).searchParams.get('pageToken'), 'C2');
  });
});

// ---------------------------------------------------------------------------
// Retry / error behavior
// ---------------------------------------------------------------------------

describe('retry behavior', () => {
  it('recovers after a single transient 500 response', async () => {
    const { transport, calls } = scriptedTransport([
      () => jsonResponse(serverErrorEnvelope, 500),
      () => jsonResponse(channelEnvelope, 200),
    ]);
    const client = makeClient(transport, { retries: 3, baseDelayMs: 1 });

    const result = await client.listChannel({ id: 'UCabc' });

    assert.equal(result.items[0]?.id, 'UCabc');
    assert.equal(calls.length, 2);
  });

  it('recovers after a single network TypeError', async () => {
    const { transport, calls } = scriptedTransport([
      () => {
        throw new TypeError('fetch failed');
      },
      () => jsonResponse(channelEnvelope, 200),
    ]);
    const client = makeClient(transport, { retries: 3, baseDelayMs: 1 });

    const result = await client.listChannel({ id: 'UCabc' });

    assert.equal(result.items[0]?.id, 'UCabc');
    assert.equal(calls.length, 2);
  });

  it('throws after exhausting 3 transient 500 responses', async () => {
    const { transport, calls } = scriptedTransport([
      () => jsonResponse(serverErrorEnvelope, 500),
      () => jsonResponse(serverErrorEnvelope, 500),
      () => jsonResponse(serverErrorEnvelope, 500),
    ]);
    const client = makeClient(transport, { retries: 3, baseDelayMs: 1 });

    await assert.rejects(
      () => client.listChannel({ id: 'UCabc' }),
      (error: unknown) => error instanceof ApiError && error.code === 500,
    );
    assert.equal(calls.length, 3);
  });

  it('throws after exhausting 3 network TypeErrors', async () => {
    const { transport, calls } = scriptedTransport([
      () => {
        throw new TypeError('fetch failed');
      },
      () => {
        throw new TypeError('fetch failed');
      },
      () => {
        throw new TypeError('fetch failed');
      },
    ]);
    const client = makeClient(transport, { retries: 3, baseDelayMs: 1 });

    await assert.rejects(
      () => client.listChannel({ id: 'UCabc' }),
      (error: unknown) => error instanceof TypeError,
    );
    assert.equal(calls.length, 3);
  });

  it('does not retry a 400 badRequest', async () => {
    const { transport, calls } = scriptedTransport([() => jsonResponse(badRequestEnvelope, 400)]);
    const client = makeClient(transport, { retries: 3, baseDelayMs: 1 });

    await assert.rejects(
      () => client.listChannel({ id: 'UCabc' }),
      (error: unknown) => error instanceof ApiError && error.code === 400,
    );
    assert.equal(calls.length, 1);
  });

  it('does not retry a 403 quotaExceeded and attaches the Google envelope', async () => {
    const { transport, calls } = scriptedTransport([() => jsonResponse(quotaEnvelope, 403)]);
    const client = makeClient(transport, { retries: 3, baseDelayMs: 1 });

    await assert.rejects(
      () => client.listChannel({ id: 'UCabc' }),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, 403);
        assert.deepEqual(error.googleError, quotaEnvelope);
        return true;
      },
    );
    assert.equal(calls.length, 1);
  });
});
