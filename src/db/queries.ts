/**
 * Read/write queries over the v1 SQLite catalog schema.
 *
 * Write path (used by the ingest CLI, #T06): idempotent upserts of a channel,
 * its videos, their comments, and the detected time anchors. Each multi-row
 * upsert runs inside a single transaction so a partially-ingested catalog is
 * never visible.
 *
 * Read path (used by the Hono server): the catalog list, a video's comments
 * (via the TTL-redacting `comments_active` view), and the channel's
 * last-refresh timestamp.
 *
 * All data here is locally constructed, but we still bind every value through
 * prepared statements (never string-interpolate user data). See
 * `docs/spec/v1/schema.sql`.
 */
import type { Channel, CommentRecord, TimeAnchor, VideoRecord } from '../shared/types.ts';
import type { DbHandle } from './sqlite.ts';

// ---------------------------------------------------------------------------
// Upserts
// ---------------------------------------------------------------------------

const UPSERT_CHANNEL_SQL = `
  INSERT INTO channels (id, title, uploads_playlist_id, fetched_at)
  VALUES (@id, @title, @uploadsPlaylistId, @fetchedAt)
  ON CONFLICT(id) DO UPDATE SET
    title = excluded.title,
    uploads_playlist_id = excluded.uploads_playlist_id,
    fetched_at = excluded.fetched_at
`;

/** Insert or overwrite the single ingested channel row. */
export function upsertChannel(handle: DbHandle, channel: Channel): void {
  handle.prepare(UPSERT_CHANNEL_SQL).run(channel);
}

const UPSERT_VIDEO_SQL = `
  INSERT INTO videos (
    id, channel_id, title, description, published_at, thumbnail_url,
    duration_iso8601, view_count, like_count, comment_count, fetched_at
  )
  VALUES (
    @id, @channelId, @title, @description, @publishedAt, @thumbnailUrl,
    @durationIso8601, @viewCount, @likeCount, @commentCount, @fetchedAt
  )
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

/** Insert or overwrite every given video in one transaction. */
export function upsertVideos(handle: DbHandle, videos: VideoRecord[]): void {
  const insert = handle.prepare(UPSERT_VIDEO_SQL);
  const tx = handle.transaction((rows: VideoRecord[]) => {
    for (const row of rows) {
      insert.run(row);
    }
  });
  tx(videos);
}

const UPSERT_COMMENT_SQL = `
  INSERT INTO comments (
    id, video_id, channel_id, author, text, published_at,
    like_count, has_anchors, fetched_at
  )
  VALUES (
    @id, @videoId, @channelId, @author, @text, @publishedAt,
    @likeCount, @hasAnchors, @fetchedAt
  )
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

/** Insert or overwrite every given comment in one transaction. */
export function upsertComments(handle: DbHandle, comments: CommentRecord[]): void {
  const insert = handle.prepare(UPSERT_COMMENT_SQL);
  const tx = handle.transaction((rows: CommentRecord[]) => {
    for (const row of rows) {
      insert.run(row);
    }
  });
  tx(comments);
}

const UPSERT_ANCHOR_SQL = `
  INSERT INTO time_anchors (comment_id, seconds, raw_text, char_position)
  VALUES (@commentId, @seconds, @rawText, @charPosition)
  ON CONFLICT(comment_id, seconds) DO UPDATE SET
    raw_text = excluded.raw_text,
    char_position = MIN(time_anchors.char_position, excluded.char_position)
`;

/**
 * Insert or overwrite every given anchor in one transaction. The
 * `(comment_id, seconds)` primary key dedupes anchors; on conflict we keep the
 * *earliest* `char_position` so re-ingesting never loses ordering provenance.
 */
export function upsertAnchors(handle: DbHandle, anchors: TimeAnchor[]): void {
  const insert = handle.prepare(UPSERT_ANCHOR_SQL);
  const tx = handle.transaction((rows: TimeAnchor[]) => {
    for (const row of rows) {
      insert.run(row);
    }
  });
  tx(anchors);
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
export function listCatalog(handle: DbHandle): VideoRecord[] {
  const rows = handle.prepare(LIST_CATALOG_SQL).all() as VideoRow[];
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
export function listVideoComments(handle: DbHandle, videoId: string): CommentRecord[] {
  const rows = handle.prepare(LIST_VIDEO_COMMENTS_SQL).all(videoId) as CommentActiveRow[];
  return rows.map(toCommentRecord);
}

const CHANNEL_LAST_REFRESHED_SQL = `
  SELECT fetched_at FROM channels ORDER BY fetched_at DESC LIMIT 1
`;

/**
 * `fetched_at` of the most recently refreshed channel, or `null` if the
 * catalog is empty.
 */
export function channelLastRefreshed(handle: DbHandle): string | null {
  const row = handle.prepare(CHANNEL_LAST_REFRESHED_SQL).get() as
    { fetched_at: string } | undefined;
  return row?.fetched_at ?? null;
}
