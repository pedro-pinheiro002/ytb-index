/**
 * Ingest write model over the Catalog schema (`db/ingest-writes`), split out
 * of `./queries.ts` by R2 (#46) (v2 spec, "Catalog read model vs Ingest write
 * model").
 *
 * Idempotent upserts of a Channel, its VideoRecords, their CommentRecords and
 * the detected TimeAnchors. Every statement is portable SQLite (positional `?`
 * parameters only, no engine-specific pragmas) and runs through the async
 * `Executor`, so the same strings work on the local better-sqlite3 driver and
 * on production D1.
 *
 * `ingestStatements` bundles a whole run into one flat statement list for
 * `Executor.batch`, which is atomic (all-or-nothing), so a partially-ingested
 * Catalog is never visible. The per-entity `upsert*` helpers keep their
 * one-transaction-per-call behavior by batching their own statements.
 *
 * Every value is bound through prepared statements, never string-interpolated.
 * Catalog reads live in `./catalog-reads.ts`; the schema lives in
 * `migrations/`.
 *
 * F3a (#49): the upserts also write the v2 columns of migration 0003
 * (Broadcast kind/state/actual times, Reply `parent_id`, `author_channel_id`,
 * `search_text`). The v2 record fields are optional, so the defaults live
 * here: `'upload'`, `NULL`, `''`, and `search_text` derived with
 * `normalizeSearchText` when a record does not carry it.
 */
import type { Channel, CommentRecord, TimeAnchor, VideoRecord } from '../shared/types.ts';
import type { Executor, Statement } from './executor.ts';
import { normalizeSearchText } from './search-text.ts';
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
    duration_iso8601, view_count, like_count, comment_count, fetched_at,
    kind, broadcast_state, actual_start_time, actual_end_time, search_text
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    fetched_at = excluded.fetched_at,
    kind = excluded.kind,
    broadcast_state = excluded.broadcast_state,
    actual_start_time = excluded.actual_start_time,
    actual_end_time = excluded.actual_end_time,
    search_text = excluded.search_text
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
    video.kind ?? 'upload',
    video.broadcastState ?? null,
    video.actualStartTime ?? null,
    video.actualEndTime ?? null,
    video.searchText ?? normalizeSearchText(`${video.title} ${video.description}`),
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
    like_count, has_anchors, fetched_at,
    author_channel_id, parent_id, search_text
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    video_id = excluded.video_id,
    channel_id = excluded.channel_id,
    author = excluded.author,
    text = excluded.text,
    published_at = excluded.published_at,
    like_count = excluded.like_count,
    has_anchors = excluded.has_anchors,
    fetched_at = excluded.fetched_at,
    author_channel_id = excluded.author_channel_id,
    parent_id = excluded.parent_id,
    search_text = excluded.search_text
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
    comment.authorChannelId ?? '',
    comment.parentId ?? null,
    comment.searchText ?? normalizeSearchText(comment.text),
  ];
}

/** A Reply has a parent; YouTube allows one level only (GLOSSARY.md). */
function isReply(comment: CommentRecord): boolean {
  return comment.parentId !== undefined && comment.parentId !== null;
}

/**
 * Upserts for `comments`, top-level CommentRecords first and Replies after
 * them (each group in input order), so a Reply's `parent_id` foreign key
 * always resolves, however a writer chunks the list.
 */
function commentStatements(comments: CommentRecord[]): Statement[] {
  const ordered = [...comments.filter((comment) => !isReply(comment)), ...comments.filter(isReply)];
  return ordered.map((comment) => ({ sql: UPSERT_COMMENT_SQL, params: commentParams(comment) }));
}

/** Insert or overwrite every given comment in one atomic batch, parents before Replies. */
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
 * Order is channels → videos → top-level comments → Replies → anchors so
 * foreign keys resolve;
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
