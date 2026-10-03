/**
 * Ingest CLI — full orchestrator (#19 / T06).
 *
 * One-shot pipeline: validate the API key, parse the channel argument, then
 * resolve the channel, page its uploads playlist, enrich the videos in batches
 * of 50, fetch each video's top-level comments, detect `TimeAnchor`s, and
 * persist everything in a single atomic `Executor.batch`.
 *
 * Sources of decisions:
 *  - `docs/spec/v1.md` §5 (ordered steps + error matrix + logging).
 *  - `.scratch/build-spec/issue.md` (module map, single seam, one transaction).
 *
 * Seams for tests:
 *  - `transport` — the same `(url, init?) => Promise<Response>` seam the
 *    YouTube client already exposes.
 *  - `quota` — inject a `QuotaCounter` (defaults to a fresh 9500-unit budget).
 *  - `now` — override the clock so `fetched_at` values are deterministic.
 */
import 'dotenv/config';
import { API_KEY_FAILURE_MESSAGES, validateApiKey } from '../yt/api-key.ts';
import { parseChannelInput, UsageError } from '../yt/parse-channel.ts';
import { ApiError, createYouTubeClient } from '../yt/client.ts';
import type {
  ChannelListResponse,
  CommentResource,
  Transport,
  VideoResource,
} from '../yt/client.ts';
import { detectAnchors } from '../yt/anchors.ts';
import { QuotaCounter, QuotaExceededError } from '../yt/quota.ts';
import { openCatalog } from '../db/sqlite.ts';
import { ingestStatements } from '../db/queries.ts';
import type {
  Channel,
  ChannelInput,
  CommentRecord,
  TimeAnchor,
  VideoRecord,
} from '../shared/types.ts';

const DEFAULT_DB_PATH = './catalog.sqlite';
const DEFAULT_API_KEY_ENV = 'YOUTUBE_API_KEY';
const VIDEO_BATCH_SIZE = 50;
const PLAYLIST_PAGE_SIZE = 50;
const COMMENT_PAGE_SIZE = 100;

/** Spec §5 — printed on stderr when the API reports quota exhaustion. */
const QUOTA_MESSAGE = '[ERROR] quota exhausted, resets at midnight Pacific Time';
/** Printed once when the running quota total crosses 8000 units. */
const QUOTA_WARN = '[WARN] quota ~8000/10000 units used';

/** Thrown when `channels.list` returns no items (unknown handle/id). */
class ChannelNotFoundError extends Error {
  override readonly name = 'ChannelNotFoundError';

  constructor(input: string) {
    super(`Error: channel not found: ${input}`);
  }
}

/** Pipeline tallies reported in the summary line. */
interface IngestSummary {
  channels: number;
  videos: number;
  comments: number;
  anchors: number;
}

/** A fetched top-level comment, paired with the video it belongs to. */
interface RawComment {
  videoId: string;
  comment: CommentResource;
}

// ---------------------------------------------------------------------------
// Google error inspection
// ---------------------------------------------------------------------------

function errorEnvelope(
  error: unknown,
): { error?: { code?: number; errors?: Array<{ reason?: string }> } } | undefined {
  if (!(error instanceof ApiError)) return undefined;
  return error.googleError as
    { error?: { code?: number; errors?: Array<{ reason?: string }> } } | undefined;
}

/** `googleError.error.errors[0].reason`, when present. */
function apiErrorReason(error: unknown): string | undefined {
  return errorEnvelope(error)?.error?.errors?.[0]?.reason;
}

/** True for the spec's `403 quotaExceeded` case. */
function isQuotaExceeded(error: unknown): boolean {
  const envelope = errorEnvelope(error);
  return envelope?.error?.code === 403 && envelope.error.errors?.[0]?.reason === 'quotaExceeded';
}

/**
 * Map a thrown error to the spec §5 exit code, printing the right stderr
 * message. Per-video `commentsDisabled` / `videoNotFound` never reach here —
 * the per-video loop handles those inline.
 */
function reportIngestError(error: unknown): number {
  if (error instanceof QuotaExceededError || isQuotaExceeded(error)) {
    process.stderr.write(`${QUOTA_MESSAGE}\n`);
    return 2;
  }
  if (error instanceof ApiError) {
    process.stderr.write(`Google error envelope: ${JSON.stringify(error.googleError)}\n`);
    return 1;
  }
  if (error instanceof ChannelNotFoundError) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  return 1;
}

// ---------------------------------------------------------------------------
// Video enrichment helpers
// ---------------------------------------------------------------------------

const THUMBNAIL_ORDER = ['maxres', 'standard', 'high', 'medium', 'default'] as const;

/**
 * The client's `VideoResource` type only models the fields this project
 * consumes; `description` / `thumbnails` are part of the raw `videos.list`
 * payload, so we read them off an augmented view of the snippet.
 */
type EnrichedSnippet = VideoResource['snippet'] & {
  description?: string;
  thumbnails?: Record<string, { url?: string } | undefined>;
};

function bestThumbnailUrl(videoId: string, thumbnails: EnrichedSnippet['thumbnails']): string {
  for (const key of THUMBNAIL_ORDER) {
    const url = thumbnails?.[key]?.url;
    if (url !== undefined && url !== '') return url;
  }
  // Deterministic fallback that always resolves for a public video.
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

function toCount(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toVideoRecord(video: VideoResource, channelId: string, fetchedAt: string): VideoRecord {
  const snippet = video.snippet as EnrichedSnippet;
  return {
    id: video.id,
    channelId,
    title: snippet.title,
    description: snippet.description ?? '',
    publishedAt: snippet.publishedAt,
    thumbnailUrl: bestThumbnailUrl(video.id, snippet.thumbnails),
    durationIso8601: video.contentDetails.duration,
    viewCount: toCount(video.statistics?.viewCount),
    likeCount: toCount(video.statistics?.likeCount),
    commentCount: toCount(video.statistics?.commentCount),
    fetchedAt,
  };
}

// ---------------------------------------------------------------------------
// Programmatic entry
// ---------------------------------------------------------------------------

/** Programmatic entry — used by tests and by the CLI shim below. */
export async function runIngest(
  args: {
    channel?: string;
    verbose?: boolean;
    dbPath?: string;
    /** Injectable transport — used by tests. Defaults to `globalThis.fetch`. */
    transport?: Transport;
    /** Injectable quota counter — used by tests. Defaults to `new QuotaCounter()`. */
    quota?: QuotaCounter;
    /** Override NOW (ms) — used by tests for deterministic `fetchedAt`. */
    now?: () => Date;
  } = {},
): Promise<number> {
  const startTimeMs = Date.now();
  const verbose = args.verbose ?? false;
  const dbPath = args.dbPath ?? DEFAULT_DB_PATH;
  const now = args.now ?? ((): Date => new Date());
  const quota = args.quota ?? new QuotaCounter();

  const log = (message: string): void => {
    process.stdout.write(`${message}\n`);
  };
  const error = (message: string): void => {
    process.stderr.write(`${message}\n`);
  };

  // 1. Validate the API key — cheapest possible fail, before any I/O.
  log('[1/8] Validating API key...');
  const key = process.env[DEFAULT_API_KEY_ENV];
  const keyResult = validateApiKey(key);
  if (!keyResult.ok) {
    error(API_KEY_FAILURE_MESSAGES[keyResult.reason]);
    return 1;
  }
  // `keyResult.ok` narrows `key` to a string only loosely; assert it here.
  const apiKey = key as string;

  // 2. Parse the channel argument.
  log('[2/8] Parsing input...');
  let channelInput: ChannelInput;
  try {
    if (args.channel === undefined || args.channel === '') {
      throw new UsageError('missing <channel> argument.');
    }
    channelInput = parseChannelInput(args.channel);
  } catch (err) {
    if (err instanceof UsageError) {
      error(`Error: ${err.message}`);
      return 1;
    }
    throw err;
  }

  // 3. Open the catalog database (migrations applied idempotently).
  log(`[3/8] Opening catalog database at ${dbPath}...`);
  const db = await openCatalog(dbPath);

  const client = createYouTubeClient({
    apiKey,
    ...(args.transport !== undefined ? { transport: args.transport } : {}),
  });

  let warnedQuota = false;

  /** Run one client call, log it under `--verbose`, and bill one quota unit. */
  async function tracked<T>(label: string, call: () => Promise<T>): Promise<T> {
    if (verbose) log(`[call] ${label}`);
    const result = await call();
    quota.consume(1);
    if (!warnedQuota && quota.total >= 8000) {
      warnedQuota = true;
      log(QUOTA_WARN);
    }
    return result;
  }

  /**
   * Steps 4–10. Reads the API and accumulates rows; every write is deferred to
   * one atomic batch in step 10. Throws on any failure.
   */
  async function runPipeline(): Promise<IngestSummary> {
    const fetchedAt = now().toISOString();

    // 4. Resolve the channel (1 unit).
    log('[4/8] Resolving channel...');
    const channelResponse: ChannelListResponse = await tracked('channels.list', () =>
      channelInput.kind === 'handle'
        ? client.listChannel({ forHandle: channelInput.value })
        : client.listChannel({ id: channelInput.value }),
    );
    const resource = channelResponse.items[0];
    if (resource === undefined) {
      throw new ChannelNotFoundError(channelInput.value);
    }

    // 5. Build the channel row (persisted with everything else in step 10).
    const channel: Channel = {
      id: resource.id,
      title: resource.snippet.title,
      uploadsPlaylistId: resource.contentDetails.relatedPlaylists.uploads,
      fetchedAt,
    };

    // 6. Page the uploads playlist, collecting video IDs (1 unit/page).
    log('[5/8] Fetching uploads playlist...');
    const videoIds: string[] = [];
    let playlistPageToken: string | undefined;
    for (;;) {
      const page = await tracked('playlistItems.list', () =>
        playlistPageToken === undefined
          ? client.listPlaylistItems({
              playlistId: channel.uploadsPlaylistId,
              maxResults: PLAYLIST_PAGE_SIZE,
            })
          : client.listPlaylistItems({
              playlistId: channel.uploadsPlaylistId,
              maxResults: PLAYLIST_PAGE_SIZE,
              pageToken: playlistPageToken,
            }),
      );
      for (const item of page.items) {
        const videoId = item.snippet.resourceId.videoId;
        if (videoId !== undefined && videoId !== '') videoIds.push(videoId);
      }
      playlistPageToken = page.nextPageToken;
      if (playlistPageToken === undefined) break;
    }

    // 7. Batch-enrich videos in chunks of ≤50 (1 unit/batch).
    log(`[6/8] Enriching ${videoIds.length} videos...`);
    const videos: VideoRecord[] = [];
    for (let offset = 0; offset < videoIds.length; offset += VIDEO_BATCH_SIZE) {
      const batch = videoIds.slice(offset, offset + VIDEO_BATCH_SIZE);
      const page = await tracked('videos.list', () => client.listVideos({ id: batch }));
      for (const item of page.items) {
        videos.push(toVideoRecord(item, channel.id, fetchedAt));
      }
    }

    // 8. Per-video comment pages (1 unit/page), top-level comments only.
    log(`[7/8] Fetching comments for ${videos.length} videos...`);
    const rawComments: RawComment[] = [];
    for (const video of videos) {
      const videoStartedMs = Date.now();
      let beforeCount = rawComments.length;
      let commentPageToken: string | undefined;
      try {
        for (;;) {
          const page = await tracked(`commentThreads.list video=${video.id}`, () =>
            commentPageToken === undefined
              ? client.listCommentThreads({
                  videoId: video.id,
                  maxResults: COMMENT_PAGE_SIZE,
                })
              : client.listCommentThreads({
                  videoId: video.id,
                  maxResults: COMMENT_PAGE_SIZE,
                  pageToken: commentPageToken,
                }),
          );
          for (const thread of page.items) {
            rawComments.push({ videoId: video.id, comment: thread.snippet.topLevelComment });
          }
          commentPageToken = page.nextPageToken;
          if (commentPageToken === undefined) break;
        }
      } catch (err) {
        const reason = apiErrorReason(err);
        if (reason === 'commentsDisabled' || reason === 'videoNotFound') {
          log(`[skip] ${video.id}: ${reason}`);
          continue;
        }
        throw err;
      }
      if (verbose) {
        log(
          `[video] ${video.id} comments=${rawComments.length - beforeCount} (${Date.now() - videoStartedMs}ms)`,
        );
      }
    }

    // 9. Detect anchors per comment; denormalize `has_anchors`.
    log('[8/8] Detecting timestamps and persisting...');
    const comments: CommentRecord[] = [];
    const anchors: TimeAnchor[] = [];
    for (const { videoId, comment } of rawComments) {
      const text = comment.snippet.textOriginal;
      const detected = detectAnchors(text);
      for (const anchor of detected) {
        anchors.push({
          commentId: comment.id,
          seconds: anchor.seconds,
          rawText: anchor.raw_text,
          charPosition: anchor.char_position,
        });
      }
      comments.push({
        id: comment.id,
        videoId,
        channelId: channel.id,
        author: comment.snippet.authorDisplayName,
        text,
        publishedAt: comment.snippet.publishedAt,
        likeCount: comment.snippet.likeCount ?? 0,
        hasAnchors: detected.length > 0 ? 1 : 0,
        fetchedAt,
      });
    }

    // 10. Persist everything in one atomic batch: channel → videos → comments
    // → anchors (FK order). `batch` is all-or-nothing, preserving ADR-0001's
    // guarantee that a failed run leaves the previous catalog untouched.
    await db.batch(ingestStatements({ channel, videos, comments, anchors }));

    return {
      channels: 1,
      videos: videos.length,
      comments: comments.length,
      anchors: anchors.length,
    };
  }

  // The whole run is one atomic batch: nothing is written until step 10
  // succeeds, so any throw leaves the previous catalog untouched.
  try {
    const summary = await runPipeline();

    // 12. Summary.
    const durationSeconds = (Date.now() - startTimeMs) / 1000;
    log('Done.');
    log(
      `channels=${summary.channels} videos=${summary.videos} comments=${summary.comments} ` +
        `anchors=${summary.anchors} duration=${durationSeconds.toFixed(1)}s quota=${quota.total}`,
    );
    return 0;
  } catch (err) {
    return reportIngestError(err);
  } finally {
    db.close();
  }
}

// CLI shim — only runs when invoked directly (`tsx src/cli/ingest.ts`).
const isCli =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('ingest.ts') === true;
if (isCli) {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose');
  const channel = args.find((a) => !a.startsWith('--'));
  runIngest({ ...(channel !== undefined ? { channel } : {}), verbose }).then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`Error: ${(err as Error).message}\n`);
      process.exit(1);
    },
  );
}
