/**
 * The Ingest pipeline (`src/ingest/pipeline`): YouTube API → Catalog rows.
 *
 * Steps 4–9 of `docs/spec/v1.md` §5, one exported function per step, plus
 * {@link collectIngestRows} that runs them in order. Nothing here writes to a
 * database, reads `process.env`, or decides exit codes: that is the CLI's job
 * (`src/cli/ingest.ts`). Every API call goes through `PipelineContext.call`,
 * so the caller owns quota accounting and `--verbose` call logging.
 *
 * Moved out of `runIngest` (build spec #12) so each step can be read, changed
 * and tested on its own; log lines and call order are unchanged.
 *
 * R1 (#45): the steps are wrapped as {@link defaultIngestStages}, run by
 * `runIngestStages` (`./stages.ts`) into a row sink; `collectIngestRows` is now
 * that run into a buffering sink, with the same logs and call order.
 *
 * F3a (#49, `docs/spec/v2.md` "Classification of Broadcasts", "Replies"):
 * enrich classifies each VideoRecord as an upload or a Broadcast and skips
 * upcoming Broadcasts (not stored, no comments fetched); comments also take
 * each thread's Replies (embedded, or paged with `comments.list` when YouTube
 * embeds fewer than `totalReplyCount`); every row carries `search_text`
 * (`normalizeSearchText`) and CommentRecords carry `authorChannelId`.
 *
 * F3b (#52, ADR-0009): enrich also hands each on-air Broadcast's
 * `activeLiveChatId` to later stages, and the comments stage records the
 * videos it skipped; the live-chat stage itself lives in `./live-chat.ts`.
 */
import { detectAnchors } from '../yt/anchors.ts';
import { ApiError } from '../yt/client.ts';
import type { CommentResource, CommentThread, VideoResource } from '../yt/client.ts';
import type { IngestRows } from '../db/queries.ts';
import { normalizeSearchText } from '../db/search-text.ts';
import {
  createBufferingSink,
  requireState,
  runIngestStages,
  type IngestStage,
  type PipelineContext,
} from './stages.ts';
import type {
  BroadcastState,
  Channel,
  ChannelInput,
  CommentRecord,
  TimeAnchor,
  VideoRecord,
} from '../shared/types.ts';

const VIDEO_BATCH_SIZE = 50;
const PLAYLIST_PAGE_SIZE = 50;
const COMMENT_PAGE_SIZE = 100;
const REPLY_PAGE_SIZE = 100;

/** Thrown when `channels.list` returns no items (unknown handle/id). */
export class ChannelNotFoundError extends Error {
  override readonly name = 'ChannelNotFoundError';

  constructor(input: string) {
    super(`Error: channel not found: ${input}`);
  }
}

export type { PipelineContext } from './stages.ts';

/** A fetched comment (top-level or Reply), paired with the video it belongs to. */
export interface RawComment {
  videoId: string;
  comment: CommentResource;
  /** The top-level comment's id when `comment` is a Reply; absent for a top-level one. */
  parentId?: string;
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
export function apiErrorReason(error: unknown): string | undefined {
  return errorEnvelope(error)?.error?.errors?.[0]?.reason;
}

/** True for the spec's `403 quotaExceeded` case. */
export function isQuotaExceeded(error: unknown): boolean {
  const envelope = errorEnvelope(error);
  return envelope?.error?.code === 403 && envelope.error.errors?.[0]?.reason === 'quotaExceeded';
}

// ---------------------------------------------------------------------------
// VideoRecord mapping
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

/**
 * What a `videos.list` item is (spec v2 "Classification of Broadcasts"): a
 * plain upload, or a Broadcast that is on air, over, or not started yet.
 */
export type VideoClassification =
  { kind: 'upload' } | { kind: 'broadcast'; state: 'live' | 'ended' | 'upcoming' };

/**
 * Classify one `videos.list` item. No `liveStreamingDetails` → upload.
 * Otherwise a Broadcast: `ended` once `actualEndTime` is set, `live` when
 * `liveBroadcastContent` says so or it has started without ending, and
 * `upcoming` when it is announced as such or has not started. Premieres and
 * live streams are not told apart (GLOSSARY.md: Broadcast). Pure.
 */
export function classifyVideo(video: VideoResource): VideoClassification {
  const details = video.liveStreamingDetails;
  if (details === undefined) return { kind: 'upload' };
  if (details.actualEndTime !== undefined && details.actualEndTime !== '') {
    return { kind: 'broadcast', state: 'ended' };
  }
  const content = video.snippet.liveBroadcastContent;
  if (content === 'live') return { kind: 'broadcast', state: 'live' };
  if (content === 'upcoming') return { kind: 'broadcast', state: 'upcoming' };
  const started = details.actualStartTime !== undefined && details.actualStartTime !== '';
  return { kind: 'broadcast', state: started ? 'live' : 'upcoming' };
}

/** True for a Broadcast that has not started: skipped at Ingest, never stored. */
export function isUpcomingBroadcast(classification: VideoClassification): boolean {
  return classification.kind === 'broadcast' && classification.state === 'upcoming';
}

/**
 * Map one `videos.list` item to a VideoRecord, with its Broadcast fields and
 * `searchText`. Throws for an upcoming Broadcast, which is never stored:
 * callers skip those first ({@link classifyVideo}).
 */
export function toVideoRecord(
  video: VideoResource,
  channelId: string,
  fetchedAt: string,
): VideoRecord {
  const snippet = video.snippet as EnrichedSnippet;
  const classification = classifyVideo(video);
  let broadcastState: BroadcastState | null = null;
  if (classification.kind === 'broadcast') {
    if (classification.state === 'upcoming') {
      throw new Error(`toVideoRecord: upcoming Broadcast ${video.id} is not stored`);
    }
    broadcastState = classification.state;
  }
  const description = snippet.description ?? '';
  return {
    id: video.id,
    channelId,
    title: snippet.title,
    description,
    publishedAt: snippet.publishedAt,
    thumbnailUrl: bestThumbnailUrl(video.id, snippet.thumbnails),
    durationIso8601: video.contentDetails.duration,
    viewCount: toCount(video.statistics?.viewCount),
    likeCount: toCount(video.statistics?.likeCount),
    commentCount: toCount(video.statistics?.commentCount),
    fetchedAt,
    kind: classification.kind,
    broadcastState,
    actualStartTime: video.liveStreamingDetails?.actualStartTime ?? null,
    actualEndTime: video.liveStreamingDetails?.actualEndTime ?? null,
    searchText: normalizeSearchText(`${snippet.title} ${description}`),
  };
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/** Steps 4–5: resolve the Channel (1 unit); throws {@link ChannelNotFoundError}. */
export async function resolveChannel(ctx: PipelineContext, input: ChannelInput): Promise<Channel> {
  const response = await ctx.call('channels.list', () =>
    input.kind === 'handle'
      ? ctx.client.listChannel({ forHandle: input.value })
      : ctx.client.listChannel({ id: input.value }),
  );
  const resource = response.items[0];
  if (resource === undefined) {
    throw new ChannelNotFoundError(input.value);
  }
  return {
    id: resource.id,
    title: resource.snippet.title,
    uploadsPlaylistId: resource.contentDetails.relatedPlaylists.uploads,
    fetchedAt: ctx.fetchedAt,
  };
}

/** Step 6: page the uploads playlist, collecting video IDs (1 unit/page). */
export async function listUploadIds(ctx: PipelineContext, playlistId: string): Promise<string[]> {
  const videoIds: string[] = [];
  let pageToken: string | undefined;
  for (;;) {
    const page = await ctx.call('playlistItems.list', () =>
      pageToken === undefined
        ? ctx.client.listPlaylistItems({ playlistId, maxResults: PLAYLIST_PAGE_SIZE })
        : ctx.client.listPlaylistItems({ playlistId, maxResults: PLAYLIST_PAGE_SIZE, pageToken }),
    );
    for (const item of page.items) {
      const videoId = item.snippet.resourceId.videoId;
      if (videoId !== undefined && videoId !== '') videoIds.push(videoId);
    }
    pageToken = page.nextPageToken;
    if (pageToken === undefined) break;
  }
  return videoIds;
}

/** What {@link enrichVideos} returns: the stored VideoRecords and the skipped ids. */
export interface EnrichedVideos {
  /** Uploads and on-air / ended Broadcasts, in `videos.list` order. */
  videos: VideoRecord[];
  /** Upcoming Broadcasts: not stored, no comments fetched (spec v2). */
  skippedVideoIds: string[];
  /** `videoId → activeLiveChatId` of each on-air Broadcast (F3b, #52). */
  liveChatIds: Map<string, string>;
}

/**
 * Step 7: batch-enrich videos in chunks of ≤50 (1 unit/batch) and classify
 * them; each upcoming Broadcast is logged as `[skip] <id>: upcoming Broadcast`
 * and left out. Each on-air Broadcast's `activeLiveChatId` is returned too.
 */
export async function enrichVideos(
  ctx: PipelineContext,
  videoIds: string[],
  channelId: string,
): Promise<EnrichedVideos> {
  const videos: VideoRecord[] = [];
  const skippedVideoIds: string[] = [];
  const liveChatIds = new Map<string, string>();
  for (let offset = 0; offset < videoIds.length; offset += VIDEO_BATCH_SIZE) {
    const batch = videoIds.slice(offset, offset + VIDEO_BATCH_SIZE);
    const page = await ctx.call('videos.list', () => ctx.client.listVideos({ id: batch }));
    for (const item of page.items) {
      if (isUpcomingBroadcast(classifyVideo(item))) {
        ctx.log(`[skip] ${item.id}: upcoming Broadcast`);
        skippedVideoIds.push(item.id);
        continue;
      }
      const video = toVideoRecord(item, channelId, ctx.fetchedAt);
      const liveChatId = item.liveStreamingDetails?.activeLiveChatId;
      if (video.broadcastState === 'live' && liveChatId !== undefined && liveChatId !== '') {
        liveChatIds.set(video.id, liveChatId);
      }
      videos.push(video);
    }
  }
  return { videos, skippedVideoIds, liveChatIds };
}

/**
 * The Replies of one thread: the embedded `replies.comments` when they are
 * all there, else every page of `comments.list?parentId=…` (1 unit/page,
 * billed through `ctx.call`) instead of the embedded subset.
 */
export async function fetchReplies(
  ctx: PipelineContext,
  thread: CommentThread,
): Promise<CommentResource[]> {
  const embedded = thread.replies?.comments ?? [];
  const total = thread.snippet.totalReplyCount ?? embedded.length;
  if (total <= embedded.length) return embedded;
  const parentId = thread.snippet.topLevelComment.id;
  const replies: CommentResource[] = [];
  let pageToken: string | undefined;
  for (;;) {
    const page = await ctx.call(`comments.list parent=${parentId}`, () =>
      pageToken === undefined
        ? ctx.client.listComments({ parentId, maxResults: REPLY_PAGE_SIZE })
        : ctx.client.listComments({ parentId, maxResults: REPLY_PAGE_SIZE, pageToken }),
    );
    for (const reply of page.items) replies.push(reply);
    pageToken = page.nextPageToken;
    if (pageToken === undefined) break;
  }
  return replies;
}

/**
 * Step 8: per-video comment pages (1 unit/page): each top-level comment
 * followed by its Replies ({@link fetchReplies}). A video with
 * `commentsDisabled` / `videoNotFound` is skipped; any other error aborts the
 * run; `onSkip` hears each skipped video id. The verbose `comments=` count is
 * top-level comments only.
 */
export async function fetchComments(
  ctx: PipelineContext,
  videos: VideoRecord[],
  onSkip: (videoId: string) => void = () => {},
): Promise<RawComment[]> {
  const rawComments: RawComment[] = [];
  for (const video of videos) {
    const videoStartedMs = Date.now();
    const beforeCount = rawComments.length;
    let pageToken: string | undefined;
    try {
      for (;;) {
        const page = await ctx.call(`commentThreads.list video=${video.id}`, () =>
          pageToken === undefined
            ? ctx.client.listCommentThreads({ videoId: video.id, maxResults: COMMENT_PAGE_SIZE })
            : ctx.client.listCommentThreads({
                videoId: video.id,
                maxResults: COMMENT_PAGE_SIZE,
                pageToken,
              }),
        );
        for (const thread of page.items) {
          const topLevel = thread.snippet.topLevelComment;
          rawComments.push({ videoId: video.id, comment: topLevel });
          for (const reply of await fetchReplies(ctx, thread)) {
            rawComments.push({ videoId: video.id, comment: reply, parentId: topLevel.id });
          }
        }
        pageToken = page.nextPageToken;
        if (pageToken === undefined) break;
      }
    } catch (err) {
      const reason = apiErrorReason(err);
      if (reason === 'commentsDisabled' || reason === 'videoNotFound') {
        ctx.log(`[skip] ${video.id}: ${reason}`);
        onSkip(video.id);
        continue;
      }
      throw err;
    }
    if (ctx.verbose) {
      ctx.log(
        `[video] ${video.id} comments=${countTopLevel(rawComments, beforeCount)} (${Date.now() - videoStartedMs}ms)`,
      );
    }
  }
  return rawComments;
}

/** Top-level entries of `rawComments` from index `from` on. */
function countTopLevel(rawComments: RawComment[], from: number): number {
  let count = 0;
  for (let index = from; index < rawComments.length; index += 1) {
    if (rawComments[index]?.parentId === undefined) count += 1;
  }
  return count;
}

/**
 * Step 9: CommentRecords (top-level and Replies) and TimeAnchors;
 * denormalizes `hasAnchors`, sets `authorChannelId` (`''` when YouTube omits
 * it), `parentId` (`null` for top-level) and `searchText`. Pure.
 */
export function toCommentRows(
  rawComments: RawComment[],
  channelId: string,
  fetchedAt: string,
): { comments: CommentRecord[]; anchors: TimeAnchor[] } {
  const comments: CommentRecord[] = [];
  const anchors: TimeAnchor[] = [];
  for (const { videoId, comment, parentId } of rawComments) {
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
      channelId,
      author: comment.snippet.authorDisplayName,
      authorChannelId: comment.snippet.authorChannelId?.value ?? '',
      parentId: parentId ?? null,
      text,
      searchText: normalizeSearchText(text),
      publishedAt: comment.snippet.publishedAt,
      likeCount: comment.snippet.likeCount ?? 0,
      hasAnchors: detected.length > 0 ? 1 : 0,
      fetchedAt,
    });
  }
  return { comments, anchors };
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

/**
 * The Ingest, steps 4–9 as stages: resolve the Channel → list uploads →
 * enrich and classify videos → comments, Replies and TimeAnchors. Each logs its spec progress line
 * and emits its rows (Channel, VideoRecords, CommentRecords + TimeAnchors).
 */
export const defaultIngestStages: readonly IngestStage[] = [
  {
    name: 'resolve-channel',
    run: async (run) => {
      run.log('[4/8] Resolving channel...');
      const channel = await resolveChannel(run, run.input);
      run.state.channel = channel;
      await run.sink.emit({ channel });
    },
  },
  {
    name: 'list-uploads',
    run: async (run) => {
      const channel = requireState(run.state, 'channel');
      run.log('[5/8] Fetching uploads playlist...');
      run.state.videoIds = await listUploadIds(run, channel.uploadsPlaylistId);
    },
  },
  {
    name: 'enrich-videos',
    run: async (run) => {
      const channel = requireState(run.state, 'channel');
      const videoIds = requireState(run.state, 'videoIds');
      run.log(`[6/8] Enriching ${videoIds.length} videos...`);
      const { videos, skippedVideoIds, liveChatIds } = await enrichVideos(
        run,
        videoIds,
        channel.id,
      );
      run.state.videos = videos;
      run.state.skippedVideoIds = skippedVideoIds;
      run.state.liveChatIds = liveChatIds;
      await run.sink.emit({ videos });
    },
  },
  {
    name: 'comments',
    run: async (run) => {
      const channel = requireState(run.state, 'channel');
      const videos = requireState(run.state, 'videos');
      run.log(`[7/8] Fetching comments for ${videos.length} videos...`);
      const commentsSkippedVideoIds: string[] = [];
      const rawComments = await fetchComments(run, videos, (videoId) => {
        commentsSkippedVideoIds.push(videoId);
      });
      run.state.commentsSkippedVideoIds = commentsSkippedVideoIds;
      run.log('[8/8] Detecting timestamps and persisting...');
      await run.sink.emit(toCommentRows(rawComments, channel.id, run.fetchedAt));
    },
  },
];

/**
 * Steps 4–9 in order: every row of one Ingest, ready for
 * `ingestStatements`. `onChannel` runs once the Channel is resolved (the CLI
 * marks the IngestRequest `running` there). Throws on any failure.
 */
export async function collectIngestRows(
  ctx: PipelineContext,
  input: ChannelInput,
  onChannel: (channel: Channel) => Promise<void> = async () => {},
): Promise<IngestRows> {
  const buffer = createBufferingSink();
  await runIngestStages(ctx, input, defaultIngestStages, {
    emit: async (batch) => {
      await buffer.emit(batch);
      if ('channel' in batch) await onChannel(batch.channel);
    },
  });
  return buffer.rows();
}
