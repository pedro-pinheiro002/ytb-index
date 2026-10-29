/**
 * Unit tests for `createYouTubeClient` (wayfinder #18 / T05; v2 calls from F2 #48, ADR-0009).
 *
 * Everything runs against a scripted fake `transport` (the single seam); no
 * network, no real timers. Retry backoff uses an injected no-op `sleep`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ApiError,
  QUOTA_COST,
  UsageError,
  createYouTubeClient,
  isLiveChatEndedError,
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
    assert.equal(
      url.searchParams.get('part'),
      'snippet,contentDetails,statistics,liveStreamingDetails',
    );
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

  it('listCommentThreads returns top-level comments with part=snippet,replies', async () => {
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
    assert.equal(url.searchParams.get('part'), 'snippet,replies');
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
// ---------------------------------------------------------------------------
// v2 additions (F2 #48): liveStreamingDetails, Replies, live chat
// ---------------------------------------------------------------------------

const broadcastVideosEnvelope = {
  kind: 'youtube#videoListResponse',
  items: [
    {
      id: 'live1',
      snippet: {
        title: 'On air',
        description: '',
        publishedAt: '2024-03-01T00:00:00Z',
        liveBroadcastContent: 'live',
        thumbnails: {},
      },
      contentDetails: { duration: 'P0D' },
      liveStreamingDetails: {
        actualStartTime: '2024-03-01T18:00:00Z',
        scheduledStartTime: '2024-03-01T17:55:00Z',
        activeLiveChatId: 'CHAT123',
      },
    },
    {
      id: 'upload1',
      snippet: {
        title: 'Plain upload',
        description: '',
        publishedAt: '2024-03-02T00:00:00Z',
        liveBroadcastContent: 'none',
        thumbnails: {},
      },
      contentDetails: { duration: 'PT5M' },
    },
  ],
};

const replyComment = (id: string) => ({
  id,
  snippet: {
    authorDisplayName: 'Bob',
    authorChannelId: { value: 'UCbob' },
    textOriginal: 'see 2:00',
    publishedAt: '2024-02-03T00:00:00Z',
    parentId: 'comment1',
  },
});

const threadWithRepliesEnvelope = {
  kind: 'youtube#commentThreadListResponse',
  items: [
    {
      id: 'comment1',
      snippet: {
        topLevelComment: {
          id: 'comment1',
          snippet: {
            authorDisplayName: 'Alice',
            authorChannelId: { value: 'UCalice' },
            textOriginal: 'great bit at 1:23',
            publishedAt: '2024-02-02T00:00:00Z',
          },
        },
        totalReplyCount: 7,
      },
      replies: {
        comments: [replyComment('comment1.r1'), replyComment('comment1.r2')],
      },
    },
  ],
};

const commentsEnvelope = {
  kind: 'youtube#commentListResponse',
  items: [replyComment('comment1.r3')],
  nextPageToken: 'REPLY_NEXT',
};

const liveChatEnvelope = {
  kind: 'youtube#liveChatMessageListResponse',
  pollingIntervalMillis: 5000,
  offlineAt: '2024-03-01T20:00:00Z',
  nextPageToken: 'CHAT_NEXT',
  items: [
    {
      id: 'msg1',
      snippet: {
        type: 'textMessageEvent',
        publishedAt: '2024-03-01T18:01:00Z',
        displayMessage: 'hello',
        textMessageDetails: { messageText: 'hello' },
      },
      authorDetails: { displayName: 'Carol', channelId: 'UCcarol' },
    },
    {
      id: 'msg2',
      snippet: {
        type: 'superChatEvent',
        publishedAt: '2024-03-01T18:02:00Z',
        displayMessage: '$5.00 from Dave: thanks!',
        superChatDetails: { userComment: 'thanks!' },
      },
      authorDetails: { displayName: 'Dave', channelId: 'UCdave' },
    },
    {
      id: 'msg3',
      snippet: { type: 'newSponsorEvent', publishedAt: '2024-03-01T18:03:00Z' },
      authorDetails: { displayName: 'Eve', channelId: 'UCeve' },
    },
  ],
};

function chatError(code: number, reason: string): ApiError {
  return new ApiError(code, {
    error: {
      code,
      message: reason,
      errors: [{ message: reason, domain: 'youtube.liveChat', reason }],
    },
  });
}

describe('v2 client calls (F2)', () => {
  it('listVideos requests liveStreamingDetails and parses Broadcasts and uploads', async () => {
    const { transport, calls } = scriptedTransport([() => jsonResponse(broadcastVideosEnvelope)]);
    const client = makeClient(transport);

    const result = await client.listVideos({ id: ['live1', 'upload1'] });

    const url = new URL(firstUrl(calls));
    assert.equal(url.pathname, '/youtube/v3/videos');
    assert.equal(
      url.searchParams.get('part'),
      'snippet,contentDetails,statistics,liveStreamingDetails',
    );
    assert.equal(url.searchParams.get('key'), API_KEY);

    const [live, upload] = result.items;
    assert.equal(live?.snippet.liveBroadcastContent, 'live');
    assert.equal(live?.liveStreamingDetails?.activeLiveChatId, 'CHAT123');
    assert.equal(live?.liveStreamingDetails?.actualStartTime, '2024-03-01T18:00:00Z');
    assert.equal(live?.liveStreamingDetails?.actualEndTime, undefined);
    assert.equal(upload?.snippet.liveBroadcastContent, 'none');
    assert.equal(upload?.liveStreamingDetails, undefined);
  });

  it('listCommentThreads parses totalReplyCount and the embedded Replies', async () => {
    const { transport, calls } = scriptedTransport([() => jsonResponse(threadWithRepliesEnvelope)]);
    const client = makeClient(transport);

    const result = await client.listCommentThreads({ videoId: 'vid1' });

    const url = new URL(firstUrl(calls));
    assert.equal(url.searchParams.get('part'), 'snippet,replies');
    assert.equal(url.searchParams.get('key'), API_KEY);

    const thread = result.items[0];
    assert.equal(thread?.snippet.totalReplyCount, 7);
    assert.equal(thread?.snippet.topLevelComment.snippet.authorChannelId?.value, 'UCalice');
    assert.equal(thread?.snippet.topLevelComment.snippet.parentId, undefined);
    assert.deepEqual(
      thread?.replies?.comments.map((c) => [c.id, c.snippet.parentId]),
      [
        ['comment1.r1', 'comment1'],
        ['comment1.r2', 'comment1'],
      ],
    );
  });

  it('listComments pages Replies by parentId with the default page size', async () => {
    const { transport, calls } = scriptedTransport([() => jsonResponse(commentsEnvelope)]);
    const client = makeClient(transport);

    const result = await client.listComments({ parentId: 'comment1' });

    const url = new URL(firstUrl(calls));
    assert.equal(url.pathname, '/youtube/v3/comments');
    assert.equal(url.searchParams.get('part'), 'snippet');
    assert.equal(url.searchParams.get('parentId'), 'comment1');
    assert.equal(url.searchParams.get('maxResults'), '100');
    assert.equal(url.searchParams.get('pageToken'), null);
    assert.equal(url.searchParams.get('textFormat'), null);
    assert.equal(url.searchParams.get('key'), API_KEY);

    assert.equal(result.items[0]?.snippet.parentId, 'comment1');
    assert.equal(result.items[0]?.snippet.authorChannelId?.value, 'UCbob');
    assert.equal(result.nextPageToken, 'REPLY_NEXT');
  });

  it('listComments forwards pageToken and maxResults, and rejects maxResults over 100', async () => {
    const { transport, calls } = scriptedTransport([() => jsonResponse(commentsEnvelope)]);
    const client = makeClient(transport);

    await client.listComments({
      parentId: 'comment1',
      pageToken: 'R2',
      maxResults: 20,
    });
    const url = new URL(firstUrl(calls));
    assert.equal(url.searchParams.get('pageToken'), 'R2');
    assert.equal(url.searchParams.get('maxResults'), '20');

    await assert.rejects(
      () => client.listComments({ parentId: 'comment1', maxResults: 101 }),
      (error: unknown) => error instanceof UsageError,
    );
    assert.equal(calls.length, 1);
  });

  it('listLiveChatMessages polls liveChat/messages and parses a page with offlineAt', async () => {
    const { transport, calls } = scriptedTransport([() => jsonResponse(liveChatEnvelope)]);
    const client = makeClient(transport);

    const result = await client.listLiveChatMessages({ liveChatId: 'CHAT123' });

    const url = new URL(firstUrl(calls));
    assert.equal(url.pathname, '/youtube/v3/liveChat/messages');
    assert.equal(url.searchParams.get('part'), 'snippet,authorDetails');
    assert.equal(url.searchParams.get('liveChatId'), 'CHAT123');
    assert.equal(url.searchParams.get('maxResults'), null);
    assert.equal(url.searchParams.get('pageToken'), null);
    assert.equal(url.searchParams.get('key'), API_KEY);

    assert.equal(result.pollingIntervalMillis, 5000);
    assert.equal(result.offlineAt, '2024-03-01T20:00:00Z');
    assert.equal(result.nextPageToken, 'CHAT_NEXT');
    const [text, superChat, other] = result.items;
    assert.equal(text?.snippet.type, 'textMessageEvent');
    assert.equal(text?.snippet.textMessageDetails?.messageText, 'hello');
    assert.equal(text?.authorDetails.displayName, 'Carol');
    assert.equal(text?.authorDetails.channelId, 'UCcarol');
    assert.equal(superChat?.snippet.type, 'superChatEvent');
    assert.equal(superChat?.snippet.superChatDetails?.userComment, 'thanks!');
    assert.equal(other?.snippet.type, 'newSponsorEvent');
    assert.equal(other?.snippet.displayMessage, undefined);
  });

  it('listLiveChatMessages forwards pageToken and maxResults, and rejects out-of-range maxResults', async () => {
    const { transport, calls } = scriptedTransport([() => jsonResponse(liveChatEnvelope)]);
    const client = makeClient(transport);

    await client.listLiveChatMessages({
      liveChatId: 'CHAT123',
      pageToken: 'P2',
      maxResults: 500,
    });
    const url = new URL(firstUrl(calls));
    assert.equal(url.searchParams.get('pageToken'), 'P2');
    assert.equal(url.searchParams.get('maxResults'), '500');

    for (const maxResults of [199, 2001]) {
      await assert.rejects(
        () => client.listLiveChatMessages({ liveChatId: 'CHAT123', maxResults }),
        (error: unknown) => error instanceof UsageError,
      );
    }
    assert.equal(calls.length, 1);
  });

  it('listLiveChatMessages surfaces a liveChatEnded response as an ended-chat ApiError', async () => {
    const ended = chatError(403, 'liveChatEnded');
    const { transport } = scriptedTransport([() => jsonResponse(ended.googleError, 403)]);
    const client = makeClient(transport);

    await assert.rejects(
      () => client.listLiveChatMessages({ liveChatId: 'CHAT123' }),
      (error: unknown) => isLiveChatEndedError(error),
    );
  });
});

describe('isLiveChatEndedError', () => {
  it('recognizes liveChatEnded, liveChatDisabled (403) and liveChatNotFound (404)', () => {
    assert.equal(isLiveChatEndedError(chatError(403, 'liveChatEnded')), true);
    assert.equal(isLiveChatEndedError(chatError(403, 'liveChatDisabled')), true);
    assert.equal(isLiveChatEndedError(chatError(404, 'liveChatNotFound')), true);
  });

  it('rejects other reasons, other statuses and non-ApiErrors', () => {
    assert.equal(isLiveChatEndedError(chatError(403, 'quotaExceeded')), false);
    assert.equal(isLiveChatEndedError(chatError(403, 'rateLimitExceeded')), false);
    assert.equal(isLiveChatEndedError(chatError(500, 'liveChatEnded')), false);
    assert.equal(isLiveChatEndedError(new ApiError(403, undefined)), false);
    assert.equal(isLiveChatEndedError(new Error('liveChatEnded')), false);
    assert.equal(isLiveChatEndedError(undefined), false);
  });
});

describe('QUOTA_COST', () => {
  it('charges 5 units for liveChatMessages.list and 1 for every other call', () => {
    assert.deepEqual(QUOTA_COST, {
      listChannel: 1,
      listPlaylistItems: 1,
      listVideos: 1,
      listCommentThreads: 1,
      listComments: 1,
      listLiveChatMessages: 5,
    });
  });
});
