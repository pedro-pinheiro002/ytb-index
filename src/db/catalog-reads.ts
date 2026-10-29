/**
 * Catalog read model (`db/catalog-reads`), split out of `./queries.ts` by R2
 * (#46) (v2 spec, "Catalog read model vs Ingest write model").
 *
 * Every read the Hono server needs: the Catalog list, one VideoRecord by id,
 * a video's CommentRecords (via the TTL-redacting `comments_active` view,
 * ADR-0001) and TimeAnchors, per-video timestamped counts, Channels (latest,
 * by id, the switcher list) and the latest IngestRequest. Search (ADR-0010)
 * will join this module later, built on `./filter.ts`.
 *
 * SQL is portable (positional `?` parameters only, no pragmas) so the same
 * strings run on better-sqlite3 and D1, and every value is bound, never
 * interpolated. Ingest writes live in `./ingest-writes.ts`.
 */
import type {
  Channel,
  CommentRecord,
  IngestRequest,
  TimeAnchor,
  VideoRecord,
} from '../shared/types.ts';
import type { Executor } from './executor.ts';
// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

interface VideoRow {
  id: string;
  channel_id: string;
  title: string;
  description: string;
  published_at: string;
  thumbnail_url: string;
  duration_iso8601: string;
  view_count: number;
  like_count: number;
  comment_count: number;
  fetched_at: string;
}

const LIST_CATALOG_SQL = `
  SELECT
    id, channel_id, title, description, published_at, thumbnail_url,
    duration_iso8601, view_count, like_count, comment_count, fetched_at
  FROM videos
  ORDER BY published_at DESC
`;

const LIST_CHANNEL_VIDEOS_SQL = `
  SELECT
    id, channel_id, title, description, published_at, thumbnail_url,
    duration_iso8601, view_count, like_count, comment_count, fetched_at
  FROM videos
  WHERE channel_id = ?
  ORDER BY published_at DESC
`;

function toVideoRecord(row: VideoRow): VideoRecord {
  return {
    id: row.id,
    channelId: row.channel_id,
    title: row.title,
    description: row.description,
    publishedAt: row.published_at,
    thumbnailUrl: row.thumbnail_url,
    durationIso8601: row.duration_iso8601,
    viewCount: row.view_count,
    likeCount: row.like_count,
    commentCount: row.comment_count,
    fetchedAt: row.fetched_at,
  };
}

/**
 * Every video in the catalog, newest-first by `published_at`. v1 ingests a
 * single channel, so no channel filter is needed.
 */
export async function listCatalog(executor: Executor): Promise<VideoRecord[]> {
  const rows = await executor.all<VideoRow>(LIST_CATALOG_SQL);
  return rows.map(toVideoRecord);
}

/**
 * Videos for one channel, newest-first by `published_at`.
 *
 * Used by the explicit `/c/:channelId` catalog route via `loadCatalog`.
 */
export async function listChannelVideos(
  executor: Executor,
  channelId: string,
): Promise<VideoRecord[]> {
  const rows = await executor.all<VideoRow>(LIST_CHANNEL_VIDEOS_SQL, [channelId]);
  return rows.map(toVideoRecord);
}

const GET_VIDEO_SQL = `
  SELECT
    id, channel_id, title, description, published_at, thumbnail_url,
    duration_iso8601, view_count, like_count, comment_count, fetched_at
  FROM videos
  WHERE id = ?
`;

/**
 * One VideoRecord by its `videoId`, or `undefined` when the Catalog has no
 * such video. A single-row primary-key lookup: it never scans the Catalog.
 */
export async function getVideo(
  executor: Executor,
  videoId: string,
): Promise<VideoRecord | undefined> {
  const row = await executor.get<VideoRow>(GET_VIDEO_SQL, [videoId]);
  return row === undefined ? undefined : toVideoRecord(row);
}

interface CommentActiveRow {
  id: string;
  video_id: string;
  channel_id: string;
  author: string;
  text: string;
  published_at: string;
  like_count: number;
  has_anchors: 0 | 1;
  fetched_at: string;
  expires_at: string;
  is_expired: 0 | 1;
}

const LIST_VIDEO_COMMENTS_SQL = `
  SELECT
    id, video_id, channel_id, author, text, published_at,
    like_count, has_anchors, fetched_at, expires_at, is_expired
  FROM comments_active
  WHERE video_id = ?
  ORDER BY published_at DESC
`;

function toCommentRecord(row: CommentActiveRow): CommentRecord {
  return {
    id: row.id,
    videoId: row.video_id,
    channelId: row.channel_id,
    author: row.author,
    text: row.text,
    publishedAt: row.published_at,
    likeCount: row.like_count,
    hasAnchors: row.has_anchors,
    fetchedAt: row.fetched_at,
    expiresAt: row.expires_at,
    isExpired: row.is_expired === 1,
  };
}

/**
 * Comments for one video, newest-first by `published_at`. Reads from the
 * `comments_active` view so TTL redaction (ADR-0001) and the derived
 * `expires_at` / `is_expired` columns flow through.
 */
export async function listVideoComments(
  executor: Executor,
  videoId: string,
): Promise<CommentRecord[]> {
  const rows = await executor.all<CommentActiveRow>(LIST_VIDEO_COMMENTS_SQL, [videoId]);
  return rows.map(toCommentRecord);
}

interface AnchorRow {
  comment_id: string;
  seconds: number;
  raw_text: string;
  char_position: number;
}

const LIST_VIDEO_ANCHORS_SQL = `
  SELECT ta.comment_id, ta.seconds, ta.raw_text, ta.char_position
  FROM time_anchors ta
  JOIN comments c ON c.id = ta.comment_id
  WHERE c.video_id = ?
  ORDER BY ta.comment_id, ta.char_position
`;

/**
 * Every TimeAnchor of one video's CommentRecords, flat, ordered by comment
 * then `char_position`. Expired comments keep their anchors (ADR-0001: the
 * anchor existed; only the body is redacted).
 */
export async function listVideoAnchors(executor: Executor, videoId: string): Promise<TimeAnchor[]> {
  const rows = await executor.all<AnchorRow>(LIST_VIDEO_ANCHORS_SQL, [videoId]);
  return rows.map((row) => ({
    commentId: row.comment_id,
    seconds: row.seconds,
    rawText: row.raw_text,
    charPosition: row.char_position,
  }));
}

interface TimestampedCountRow {
  video_id: string;
  timestamped: number | null;
}

const TIMESTAMPED_COUNTS_SQL = `
  SELECT video_id, SUM(has_anchors) AS timestamped
  FROM comments
  GROUP BY video_id
`;

/**
 * Map of `videoId` → number of that video's CommentRecords holding at least
 * one TimeAnchor (`has_anchors = 1`). Videos without comments are absent.
 */
export async function timestampedCounts(executor: Executor): Promise<Map<string, number>> {
  const rows = await executor.all<TimestampedCountRow>(TIMESTAMPED_COUNTS_SQL);
  return new Map(rows.map((row) => [row.video_id, Number(row.timestamped ?? 0)]));
}

const CHANNEL_LAST_REFRESHED_SQL = `
  SELECT fetched_at FROM channels ORDER BY fetched_at DESC LIMIT 1
`;

/**
 * `fetched_at` of the most recently refreshed channel, or `null` if the
 * catalog is empty.
 */
export async function channelLastRefreshed(executor: Executor): Promise<string | null> {
  const row = await executor.get<{ fetched_at: string }>(CHANNEL_LAST_REFRESHED_SQL);
  return row?.fetched_at ?? null;
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

interface ChannelRow {
  id: string;
  title: string;
  uploads_playlist_id: string;
  fetched_at: string;
}

const GET_LATEST_CHANNEL_SQL = `
  SELECT id, title, uploads_playlist_id, fetched_at
  FROM channels
  ORDER BY fetched_at DESC
  LIMIT 1
`;

const GET_CHANNEL_SQL = `
  SELECT id, title, uploads_playlist_id, fetched_at
  FROM channels
  WHERE id = ?
`;

function toChannel(row: ChannelRow): Channel {
  return {
    id: row.id,
    title: row.title,
    uploadsPlaylistId: row.uploads_playlist_id,
    fetchedAt: row.fetched_at,
  };
}

/** The most recently refreshed Channel, or `undefined` when none is ingested. */
export async function getLatestChannel(executor: Executor): Promise<Channel | undefined> {
  const row = await executor.get<ChannelRow>(GET_LATEST_CHANNEL_SQL);
  return row === undefined ? undefined : toChannel(row);
}

/** The Channel with this channel ID, or `undefined` when it is not in the Catalog. */
export async function getChannel(
  executor: Executor,
  channelId: string,
): Promise<Channel | undefined> {
  const row = await executor.get<ChannelRow>(GET_CHANNEL_SQL, [channelId]);
  return row === undefined ? undefined : toChannel(row);
}

interface ChannelListRow {
  id: string;
  title: string;
}

const LIST_CHANNELS_SQL = `
  SELECT id, title
  FROM channels
  ORDER BY fetched_at DESC, id DESC
`;

/**
 * All ingested channels, most-recently-refreshed first.
 *
 * Used by the catalog-page channel switcher.
 */
export async function listChannels(
  executor: Executor,
): Promise<Array<{ id: string; title: string }>> {
  const rows = await executor.all<ChannelListRow>(LIST_CHANNELS_SQL);
  return rows.map((row) => ({ id: row.id, title: row.title }));
}

// ---------------------------------------------------------------------------
// Ingest request status
// ---------------------------------------------------------------------------

interface IngestRequestRow {
  id: string;
  channel_input: string;
  channel_key: string;
  channel_id: string | null;
  status: string;
  videos_written: number;
  comments_written: number;
  error: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

const LATEST_INGEST_STATUS_SQL = `
  SELECT
    id, channel_input, channel_key, channel_id, status,
    videos_written, comments_written, error, created_at, updated_at, finished_at
  FROM ingest_requests
  ORDER BY updated_at DESC
  LIMIT 1
`;

function toIngestRequest(row: IngestRequestRow): IngestRequest {
  return {
    id: row.id,
    channelInput: row.channel_input,
    channelKey: row.channel_key,
    channelId: row.channel_id,
    status: row.status as IngestRequest['status'],
    videosWritten: row.videos_written,
    commentsWritten: row.comments_written,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

/**
 * The most recently updated IngestRequest, or `null` when none exist.
 *
 * Public-read; the UI only reveals it to an Operator with a stored token.
 */
export async function loadLatestIngestStatus(executor: Executor): Promise<IngestRequest | null> {
  const row = await executor.get<IngestRequestRow>(LATEST_INGEST_STATUS_SQL);
  return row === undefined ? null : toIngestRequest(row);
}
