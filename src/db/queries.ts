/**
 * Read/write queries over the v1 catalog schema.
 *
 * Write path (used by the ingest CLI, #T06): idempotent upserts of a channel,
 * its videos, their comments, and the detected time anchors. Every statement
 * is portable SQLite — positional `?` parameters only, no engine-specific
 * pragmas — and runs through the async `Executor`, so the same strings work on
 * the local better-sqlite3 driver and on production D1.
 *
 * `ingestStatements` bundles a whole run into one flat statement list for
 * `Executor.batch`, which is atomic (all-or-nothing), so a partially-ingested
 * catalog is never visible. The per-entity `upsert*` helpers keep their old
 * one-transaction-per-call behavior by batching their own statements.
 *
 * Read path (used by the Hono server): the catalog list, a video's comments
 * (via the TTL-redacting `comments_active` view), and the channel's
 * last-refresh timestamp.
 *
 * All data here is locally constructed, but we still bind every value through
 * prepared statements (never string-interpolate user data). The schema lives
 * in `migrations/0001_init.sql`.
 */
import type { Channel, CommentRecord, TimeAnchor, VideoRecord } from '../shared/types.ts';
import type { Executor, Statement } from './executor.ts';

// ---------------------------------------------------------------------------
// Upserts
// ---------------------------------------------------------------------------

const UPSERT_CHANNEL_SQL = `
  INSERT INTO channels (id, title, uploads_playlist_id, fetched_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    title = excluded.title,
    uploads_playlist_id = excluded.uploads_playlist_id,
    fetched_at = excluded.fetched_at
`;

function channelParams(channel: Channel): unknown[] {
  return [channel.id, channel.title, channel.uploadsPlaylistId, channel.fetchedAt];
}

function channelStatement(channel: Channel): Statement {
  return { sql: UPSERT_CHANNEL_SQL, params: channelParams(channel) };
}

/** Insert or overwrite the single ingested channel row. */
export async function upsertChannel(executor: Executor, channel: Channel): Promise<void> {
  await executor.run(UPSERT_CHANNEL_SQL, channelParams(channel));
}

const UPSERT_VIDEO_SQL = `
  INSERT INTO videos (
    id, channel_id, title, description, published_at, thumbnail_url,
    duration_iso8601, view_count, like_count, comment_count, fetched_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    channel_id = excluded.channel_id,
    title = excluded.title,
    description = excluded.description,
    published_at = excluded.published_at,
    thumbnail_url = excluded.thumbnail_url,
    duration_iso8601 = excluded.duration_iso8601,
    view_count = excluded.view_count,
    like_count = excluded.like_count,
    comment_count = excluded.comment_count,
    fetched_at = excluded.fetched_at
`;

function videoParams(video: VideoRecord): unknown[] {
  return [
    video.id,
    video.channelId,
    video.title,
    video.description,
    video.publishedAt,
    video.thumbnailUrl,
    video.durationIso8601,
    video.viewCount,
    video.likeCount,
    video.commentCount,
    video.fetchedAt,
  ];
}

function videoStatements(videos: VideoRecord[]): Statement[] {
  return videos.map((video) => ({ sql: UPSERT_VIDEO_SQL, params: videoParams(video) }));
}

/** Insert or overwrite every given video in one atomic batch. */
export async function upsertVideos(executor: Executor, videos: VideoRecord[]): Promise<void> {
  await executor.batch(videoStatements(videos));
}

const UPSERT_COMMENT_SQL = `
  INSERT INTO comments (
    id, video_id, channel_id, author, text, published_at,
    like_count, has_anchors, fetched_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    video_id = excluded.video_id,
    channel_id = excluded.channel_id,
    author = excluded.author,
    text = excluded.text,
    published_at = excluded.published_at,
    like_count = excluded.like_count,
    has_anchors = excluded.has_anchors,
    fetched_at = excluded.fetched_at
`;

function commentParams(comment: CommentRecord): unknown[] {
  return [
    comment.id,
    comment.videoId,
    comment.channelId,
    comment.author,
    comment.text,
    comment.publishedAt,
    comment.likeCount,
    comment.hasAnchors,
    comment.fetchedAt,
  ];
}

function commentStatements(comments: CommentRecord[]): Statement[] {
  return comments.map((comment) => ({ sql: UPSERT_COMMENT_SQL, params: commentParams(comment) }));
}

/** Insert or overwrite every given comment in one atomic batch. */
export async function upsertComments(executor: Executor, comments: CommentRecord[]): Promise<void> {
  await executor.batch(commentStatements(comments));
}

const UPSERT_ANCHOR_SQL = `
  INSERT INTO time_anchors (comment_id, seconds, raw_text, char_position)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(comment_id, seconds) DO UPDATE SET
    raw_text = excluded.raw_text,
    char_position = MIN(time_anchors.char_position, excluded.char_position)
`;

function anchorParams(anchor: TimeAnchor): unknown[] {
  return [anchor.commentId, anchor.seconds, anchor.rawText, anchor.charPosition];
}

function anchorStatements(anchors: TimeAnchor[]): Statement[] {
  return anchors.map((anchor) => ({ sql: UPSERT_ANCHOR_SQL, params: anchorParams(anchor) }));
}

/**
 * Insert or overwrite every given anchor in one atomic batch. The
 * `(comment_id, seconds)` primary key dedupes anchors; on conflict we keep the
 * *earliest* `char_position` so re-ingesting never loses ordering provenance.
 */
export async function upsertAnchors(executor: Executor, anchors: TimeAnchor[]): Promise<void> {
  await executor.batch(anchorStatements(anchors));
}

// ---------------------------------------------------------------------------
// Ingest batch
// ---------------------------------------------------------------------------

/** Everything one ingest run writes, in FK-safe order. */
export interface IngestRows {
  channel: Channel;
  videos: VideoRecord[];
  comments: CommentRecord[];
  anchors: TimeAnchor[];
}

/**
 * Flatten one ingest run into a single statement list for `Executor.batch`.
 * Order is channels → videos → comments → anchors so foreign keys resolve;
 * the batch itself is atomic (ADR-0001's all-or-nothing catalog refresh).
 */
export function ingestStatements({ channel, videos, comments, anchors }: IngestRows): Statement[] {
  return [
    channelStatement(channel),
    ...videoStatements(videos),
    ...commentStatements(comments),
    ...anchorStatements(anchors),
  ];
}

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
