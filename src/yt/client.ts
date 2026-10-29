/**
 * YouTube Data API v3 client (`yt/client`).
 *
 * Source of decisions: wayfinder #18 (T05) + build spec #12; v2 additions from
 * F2 (#48), `docs/spec/v2.md` ("Modules", "Replies", "LiveChatMessage") and
 * ADR-0009 (live chat from the official API, on-air Broadcasts only).
 *
 * Design:
 *  - One seam: an injectable `transport` (`(url, init?) => Promise<Response>`).
 *    The default is `globalThis.fetch`; tests inject a fake.
 *  - Every public method builds a URL with `URLSearchParams` (including the
 *    `key` param), sends it through the retrying transport, parses JSON, and
 *    returns a typed Google envelope.
 *  - Non-2xx responses throw `ApiError` carrying the full Google error
 *    envelope on `.googleError`.
 *  - `retryTransport` retries 429 / 5xx / network (`TypeError`) only. It does
 *    NOT special-case `403 quotaExceeded`: quota short-circuiting is the
 *    caller's job (T06 wires `QuotaCounter` before/around these calls), which
 *    keeps this module ignorant of quota state.
 *
 * Spec §5 endpoints (locked):
 *  - channels.list       `part=snippet,contentDetails` + (`forHandle` | `id`)
 *  - playlistItems.list  `part=snippet` + `playlistId` + `maxResults` + `pageToken`
 *  - videos.list         `part=snippet,contentDetails,statistics,liveStreamingDetails`
 *                        + `id` (≤ 50)
 *  - commentThreads.list `part=snippet,replies` + `videoId` + `maxResults` + `pageToken`
 *  - comments.list       `part=snippet` + `parentId` + `maxResults` (≤ 100) + `pageToken`
 *  - liveChatMessages.list  `GET liveChat/messages`, `part=snippet,authorDetails`
 *                        + `liveChatId` + optional `maxResults` (200–2000) + `pageToken`
 *
 * No call sets `textFormat`: the client reads `snippet.textOriginal`, which is
 * the raw text whatever the format, so `comments.list` follows the same rule.
 *
 * Per-call quota costs are exported as `QUOTA_COST`; billing stays the caller's
 * job through `QuotaCounter` (spec v2 "Modules").
 */

const BASE_URL = 'https://www.googleapis.com/youtube/v3';

/** Transport seam: build a request for an absolute URL and resolve its response. */
export type Transport = (url: string, init?: RequestInit) => Promise<Response>;

/** Sleep seam so tests can avoid real timers. */
export type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Thrown for locally-detectable caller mistakes (invalid method arguments). */
export class UsageError extends Error {
  override readonly name = 'UsageError';

  constructor(message: string) {
    super(message);
  }
}

/** Google error envelope as returned by every YouTube Data API endpoint. */
export interface GoogleErrorEnvelope {
  error: {
    code: number;
    message: string;
    errors?: Array<{ message: string; domain: string; reason: string }>;
    status?: string;
  };
}

function isGoogleErrorEnvelope(value: unknown): value is GoogleErrorEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const err = (value as { error?: unknown }).error;
  return typeof err === 'object' && err !== null;
}

/** Thrown for any non-2xx YouTube API response; carries the raw Google envelope. */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  /** Convenience copy of the Google `error.code` (falls back to HTTP status). */
  readonly code: number;
  /** The parsed Google error envelope (or `undefined` if the body was not JSON). */
  readonly googleError: unknown;

  constructor(code: number, googleError: unknown, message?: string) {
    super(message ?? `YouTube API error (HTTP ${code})`);
    this.code = code;
    this.googleError = googleError;
  }
}

function errorMessageOf(googleError: unknown): string | undefined {
  if (isGoogleErrorEnvelope(googleError) && typeof googleError.error.message === 'string') {
    return googleError.error.message;
  }
  return undefined;
}

function errorCodeOf(googleError: unknown, fallback: number): number {
  if (isGoogleErrorEnvelope(googleError) && typeof googleError.error.code === 'number') {
    return googleError.error.code;
  }
  return fallback;
}

/** HTTP statuses the retry helper considers transient. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Wrap a transport so transient failures are retried with exponential backoff.
 *
 * Retries on 429 / 5xx responses and on `TypeError` thrown by the transport
 * (the shape `fetch` uses for network failures). `retries` is the total number
 * of attempts, not the number of additional ones. Delays are
 * `baseDelayMs * 2 ** (attempt - 1)`.
 *
 * On exhaustion it returns the final retryable `Response` (so the caller can
 * build an `ApiError` from its envelope) or rethrows the final `TypeError`.
 */
export function retryTransport(
  transport: Transport,
  retries = 3,
  baseDelayMs = 1000,
  sleep: Sleep = defaultSleep,
): Transport {
  return async (url, init) => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      try {
        const response = await transport(url, init);
        if (!isRetryableStatus(response.status) || attempt === retries) {
          return response;
        }
      } catch (error) {
        // Only network-level failures (fetch `TypeError`) are retried; anything
        // else is a programming error and surfaced immediately.
        if (!(error instanceof TypeError) || attempt === retries) {
          throw error;
        }
        lastError = error;
      }
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
    throw lastError ?? new Error('retryTransport: exhausted without a result');
  };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function buildUrl(path: string, params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, value);
  }
  return `${BASE_URL}/${path}?${search.toString()}`;
}

// ---------------------------------------------------------------------------
// Google response envelopes (only the fields this project consumes)
// ---------------------------------------------------------------------------

export interface ChannelResource {
  id: string;
  snippet: { title: string };
  contentDetails: { relatedPlaylists: { uploads: string } };
}

export interface ChannelListResponse {
  items: ChannelResource[];
}

export interface PlaylistItem {
  id: string;
  snippet: {
    title: string;
    publishedAt: string;
    resourceId: { videoId: string };
  };
}

export interface PlaylistItemListResponse {
  items: PlaylistItem[];
  nextPageToken?: string;
}

/** Thumbnail entry as returned by YouTube Data API v3 `videos.list` (`snippet.thumbnails.*`). */
export interface VideoThumbnail {
  url: string;
  width?: number;
  height?: number;
}

/**
 * `videos.list` `liveStreamingDetails` part. Present only for Broadcasts (live
 * streams and premieres); absent for ordinary uploads (spec v2 "Classification
 * of Broadcasts"). `activeLiveChatId` exists only while the Broadcast is on air
 * (ADR-0009).
 */
export interface LiveStreamingDetails {
  actualStartTime?: string;
  actualEndTime?: string;
  scheduledStartTime?: string;
  activeLiveChatId?: string;
}

/** `snippet.liveBroadcastContent` values documented for `videos.list`. */
export type LiveBroadcastContent = 'none' | 'live' | 'upcoming';

/** Video resource from `videos.list` (only the fields this project consumes). */
export interface VideoResource {
  id: string;
  snippet: {
    title: string;
    description: string;
    publishedAt: string;
    channelId?: string;
    /** `none` for uploads and ended Broadcasts, `live` on air, `upcoming` before start. */
    liveBroadcastContent?: LiveBroadcastContent;
    /** `snippet.thumbnails` — pick the highest-resolution entry at the call site. */
    thumbnails: {
      default?: VideoThumbnail;
      medium?: VideoThumbnail;
      high?: VideoThumbnail;
      standard?: VideoThumbnail;
      maxres?: VideoThumbnail;
    };
  };
  contentDetails: { duration: string };
  statistics?: {
    viewCount?: string;
    likeCount?: string;
    commentCount?: string;
  };
  /** Absent for uploads; see {@link LiveStreamingDetails}. */
  liveStreamingDetails?: LiveStreamingDetails;
}

export interface VideoListResponse {
  items: VideoResource[];
}

export interface CommentResource {
  id: string;
  snippet: {
    authorDisplayName: string;
    textOriginal: string;
    publishedAt: string;
    likeCount?: number;
    videoId?: string;
    /** The commenter's channel; absent for some deleted or legacy accounts. */
    authorChannelId?: { value: string };
    /** Set on a Reply: the id of the top-level comment it answers. */
    parentId?: string;
  };
}

/** Comment thread from `commentThreads.list?part=snippet,replies`. */
export interface CommentThread {
  id: string;
  snippet: {
    topLevelComment: CommentResource;
    /** Total Replies to the top-level comment (may exceed `replies.comments`). */
    totalReplyCount?: number;
  };
  /**
   * Embedded Replies: only a subset when fewer than `snippet.totalReplyCount`;
   * page `listComments({ parentId })` for the rest (spec v2 "Replies").
   */
  replies?: { comments: CommentResource[] };
}

export interface CommentThreadListResponse {
  items: CommentThread[];
  nextPageToken?: string;
}

/** `comments.list` response: one page of Replies to a top-level comment. */
export interface CommentListResponse {
  items: CommentResource[];
  nextPageToken?: string;
}

/**
 * `snippet.type` of a live chat message. The two types the Catalog stores are
 * named (ADR-0009); every other documented type (membership, sticker,
 * moderation, poll, …) is passed through as a plain string.
 */
export type LiveChatMessageType = 'textMessageEvent' | 'superChatEvent' | (string & {});

/** Live chat message from `liveChatMessages.list` (only the consumed fields). */
export interface LiveChatMessageResource {
  id: string;
  snippet: {
    type: LiveChatMessageType;
    publishedAt: string;
    liveChatId?: string;
    authorChannelId?: string;
    displayMessage?: string;
    textMessageDetails?: { messageText: string };
    superChatDetails?: { userComment?: string };
  };
  authorDetails: {
    displayName: string;
    channelId: string;
  };
}

/** `liveChatMessages.list` response: one poll's worth of messages. */
export interface LiveChatMessageListResponse {
  items: LiveChatMessageResource[];
  nextPageToken?: string;
  /** Server-chosen wait before the next poll. */
  pollingIntervalMillis: number;
  /** Set once the chat has gone offline; stop polling (ADR-0009). */
  offlineAt?: string;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface ListChannelParams {
  forHandle?: string;
  id?: string;
}

export interface ListPlaylistItemsParams {
  playlistId: string;
  pageToken?: string;
  maxResults?: number;
}

export interface ListVideosParams {
  id: string[];
}

export interface ListCommentThreadsParams {
  videoId: string;
  pageToken?: string;
  maxResults?: number;
}

/** Arguments of {@link YouTubeV2Client.listComments}. */
export interface ListCommentsParams {
  /** Top-level comment whose Replies to list. */
  parentId: string;
  pageToken?: string;
  /** 1–100; default 100. */
  maxResults?: number;
}

/** Arguments of {@link YouTubeV2Client.listLiveChatMessages}. */
export interface ListLiveChatMessagesParams {
  /** `videos.list` → `liveStreamingDetails.activeLiveChatId`. */
  liveChatId: string;
  pageToken?: string;
  /** 200–2000; omitted means the API default. */
  maxResults?: number;
}

/** The v1 client surface: the four calls the v1 Ingest pipeline uses. */
export interface YouTubeClient {
  listChannel(params: ListChannelParams): Promise<ChannelListResponse>;
  listPlaylistItems(params: ListPlaylistItemsParams): Promise<PlaylistItemListResponse>;
  listVideos(params: ListVideosParams): Promise<VideoListResponse>;
  listCommentThreads(params: ListCommentThreadsParams): Promise<CommentThreadListResponse>;
}

/**
 * The full client (F2, #48): the v1 surface plus Replies and live chat.
 *
 * Kept as a separate interface so in-memory `YouTubeClient` fakes written for
 * v1 (e.g. in `src/ingest/pipeline.test.ts`) keep compiling; once every fake
 * implements the two new calls, the two interfaces can be merged.
 */
export interface YouTubeV2Client extends YouTubeClient {
  /** `comments.list?parentId=…`: one page of Replies to a top-level comment. */
  listComments(params: ListCommentsParams): Promise<CommentListResponse>;
  /** `liveChatMessages.list`: one poll of an active live chat (ADR-0009). */
  listLiveChatMessages(params: ListLiveChatMessagesParams): Promise<LiveChatMessageListResponse>;
}

/**
 * Quota units charged per call of each client method.
 *
 * Source: the Data API Quota Calculator
 * (developers.google.com/youtube/v3/determine_quota_cost) via
 * `docs/research/youtube-data-api-v3.md` §3 for the 1-unit read calls, and
 * spec v2 "Modules" / ADR-0009 for `liveChatMessages.list` = 5. The 5-unit
 * figure could NOT be checked against Google's own pages when F2 was written
 * (developers.google.com was unreachable from the build environment); only
 * third-party docs confirmed it. Re-check before relying on it for budgets.
 */
export const QUOTA_COST: Readonly<Record<keyof YouTubeV2Client, number>> = Object.freeze({
  listChannel: 1,
  listPlaylistItems: 1,
  listVideos: 1,
  listCommentThreads: 1,
  listComments: 1,
  listLiveChatMessages: 5,
});

/**
 * Error reasons meaning a live chat can no longer be polled. `liveChatEnded`
 * and `liveChatDisabled` are 403, `liveChatNotFound` is 404 (Live Streaming
 * API `liveChatMessages` errors table, read via search-result excerpts of the
 * official reference; the page itself was unreachable when F2 was written).
 */
const LIVE_CHAT_ENDED_REASONS: ReadonlySet<string> = new Set([
  'liveChatEnded',
  'liveChatNotFound',
  'liveChatDisabled',
]);

/**
 * True when `error` is an `ApiError` saying the live chat has ended (or is
 * gone or disabled): HTTP 403/404 with reason `liveChatEnded`,
 * `liveChatNotFound` or `liveChatDisabled`. Capture should stop, not fail
 * (ADR-0009). Other errors, including 403 `rateLimitExceeded`, return false.
 */
export function isLiveChatEndedError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.code !== 403 && error.code !== 404) return false;
  if (!isGoogleErrorEnvelope(error.googleError)) return false;
  const reasons = error.googleError.error.errors ?? [];
  return reasons.some((e) => LIVE_CHAT_ENDED_REASONS.has(e.reason));
}

export interface RetryOptions {
  /** Total attempts. Default 3. */
  retries?: number;
  /** First backoff delay in ms. Default 1000. */
  baseDelayMs?: number;
  /** Sleep implementation (tests inject a no-op). */
  sleep?: Sleep;
}

export interface YouTubeClientOptions {
  apiKey: string;
  /** Defaults to `globalThis.fetch`. */
  transport?: Transport;
  retry?: RetryOptions;
}

/** Build the YouTube Data API client over the (retrying) `transport` seam. */
export function createYouTubeClient(options: YouTubeClientOptions): YouTubeV2Client {
  const { apiKey } = options;
  const baseTransport: Transport =
    options.transport ?? ((url, init) => globalThis.fetch(url, init));
  const { retries = 3, baseDelayMs = 1000, sleep = defaultSleep } = options.retry ?? {};
  const send = retryTransport(baseTransport, retries, baseDelayMs, sleep);

  async function request<T>(url: string): Promise<T> {
    const response = await send(url);
    const body = await readJson(response);
    if (!response.ok) {
      throw new ApiError(
        errorCodeOf(body, response.status),
        body,
        errorMessageOf(body) ?? `YouTube API error (HTTP ${response.status})`,
      );
    }
    return body as T;
  }

  return {
    async listChannel(params) {
      const hasHandle = params.forHandle !== undefined;
      const hasId = params.id !== undefined;
      if (hasHandle === hasId) {
        throw new UsageError('listChannel requires exactly one of `forHandle` or `id`');
      }
      const url = buildUrl('channels', {
        part: 'snippet,contentDetails',
        forHandle: params.forHandle,
        id: params.id,
        key: apiKey,
      });
      return request<ChannelListResponse>(url);
    },

    async listPlaylistItems(params) {
      const url = buildUrl('playlistItems', {
        part: 'snippet',
        playlistId: params.playlistId,
        maxResults: String(params.maxResults ?? 50),
        pageToken: params.pageToken,
        key: apiKey,
      });
      return request<PlaylistItemListResponse>(url);
    },

    async listVideos(params) {
      if (params.id.length > 50) {
        throw new UsageError('listVideos accepts at most 50 video IDs per call');
      }
      const url = buildUrl('videos', {
        part: 'snippet,contentDetails,statistics,liveStreamingDetails',
        id: params.id.join(','),
        key: apiKey,
      });
      return request<VideoListResponse>(url);
    },

    async listCommentThreads(params) {
      const url = buildUrl('commentThreads', {
        part: 'snippet,replies',
        videoId: params.videoId,
        maxResults: String(params.maxResults ?? 100),
        pageToken: params.pageToken,
        key: apiKey,
      });
      return request<CommentThreadListResponse>(url);
    },

    async listComments(params) {
      const maxResults = params.maxResults ?? 100;
      if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 100) {
        throw new UsageError('listComments maxResults must be an integer from 1 to 100');
      }
      const url = buildUrl('comments', {
        part: 'snippet',
        parentId: params.parentId,
        maxResults: String(maxResults),
        pageToken: params.pageToken,
        key: apiKey,
      });
      return request<CommentListResponse>(url);
    },

    async listLiveChatMessages(params) {
      const { maxResults } = params;
      if (
        maxResults !== undefined &&
        (!Number.isInteger(maxResults) || maxResults < 200 || maxResults > 2000)
      ) {
        throw new UsageError('listLiveChatMessages maxResults must be an integer from 200 to 2000');
      }
      // REST path of liveChatMessages.list. Not re-checked against the official
      // reference when F2 was written (developers.google.com unreachable).
      const url = buildUrl('liveChat/messages', {
        part: 'snippet,authorDetails',
        liveChatId: params.liveChatId,
        maxResults: maxResults === undefined ? undefined : String(maxResults),
        pageToken: params.pageToken,
        key: apiKey,
      });
      return request<LiveChatMessageListResponse>(url);
    },
  };
}
