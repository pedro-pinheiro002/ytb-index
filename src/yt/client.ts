/**
 * YouTube Data API v3 client (`yt/client`).
 *
 * Source of decisions: wayfinder #18 (T05) + build spec (.scratch/build-spec/issue.md).
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
 *  - videos.list         `part=snippet,contentDetails,statistics` + `id` (≤ 50)
 *  - commentThreads.list `part=snippet` + `videoId` + `maxResults` + `pageToken`
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

export interface VideoResource {
  id: string;
  snippet: {
    title: string;
    publishedAt: string;
    channelId?: string;
  };
  contentDetails: { duration: string };
  statistics?: {
    viewCount?: string;
    likeCount?: string;
    commentCount?: string;
  };
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
  };
}

export interface CommentThread {
  id: string;
  snippet: {
    /** Only the top-level comment is exposed; `replies` is intentionally ignored. */
    topLevelComment: CommentResource;
  };
}

export interface CommentThreadListResponse {
  items: CommentThread[];
  nextPageToken?: string;
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

export interface YouTubeClient {
  listChannel(params: ListChannelParams): Promise<ChannelListResponse>;
  listPlaylistItems(params: ListPlaylistItemsParams): Promise<PlaylistItemListResponse>;
  listVideos(params: ListVideosParams): Promise<VideoListResponse>;
  listCommentThreads(params: ListCommentThreadsParams): Promise<CommentThreadListResponse>;
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

export function createYouTubeClient(options: YouTubeClientOptions): YouTubeClient {
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
        part: 'snippet,contentDetails,statistics',
        id: params.id.join(','),
        key: apiKey,
      });
      return request<VideoListResponse>(url);
    },

    async listCommentThreads(params) {
      const url = buildUrl('commentThreads', {
        part: 'snippet',
        videoId: params.videoId,
        maxResults: String(params.maxResults ?? 100),
        pageToken: params.pageToken,
        key: apiKey,
      });
      return request<CommentThreadListResponse>(url);
    },
  };
}
