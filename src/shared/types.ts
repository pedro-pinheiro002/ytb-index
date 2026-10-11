/**
 * Canonical domain types for ytb-index.
 *
 * Source of definitions: GLOSSARY.md (the operator-facing vocabulary).
 * Source of decisions: wayfinder #3 (glossary) and #12 (build spec).
 *
 * Conventions:
 * - All timestamps are ISO-8601 UTC strings (per spec §4 and ADR-0001).
 * - `Channel` / `VideoRecord` / `CommentRecord` / `TimeAnchor` mirror the SQLite tables 1:1.
 * - `TimestampedComment` is a derived view: a `CommentRecord` whose `has_anchors = 1`.
 * - `ChannelInput` is a discriminated union from `parseChannelInput` (#T03).
 */

/** One YouTube channel — one row in `channels`. */
export interface Channel {
  /** YouTube channel ID, e.g. `UCxxxxxxxxxxxxxxxxxxxxxx`. */
  id: string;
  /** Display title from `snippet.title`. */
  title: string;
  /** Uploads playlist ID from `contentDetails.relatedPlaylists.uploads`. */
  uploadsPlaylistId: string;
  /** ISO-8601 UTC; refreshed on every ingest run. ADR-0001. */
  fetchedAt: string;
}

/** One uploaded video on a channel — one row in `videos`. */
export interface VideoRecord {
  /** YouTube video ID. */
  id: string;
  /** FK to `channels.id`. */
  channelId: string;
  title: string;
  description: string;
  /** ISO-8601 UTC; `snippet.publishedAt`. */
  publishedAt: string;
  /** Best thumbnail URL (bytes not stored per III.E.1). */
  thumbnailUrl: string;
  /** ISO-8601 duration, `contentDetails.duration` (e.g. `PT5M32S`). */
  durationIso8601: string;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  /** ISO-8601 UTC; ADR-0001. */
  fetchedAt: string;
}

/** One top-level comment — one row in `comments`. Replies out of scope. */
export interface CommentRecord {
  /** YouTube comment ID. */
  id: string;
  /** FK to `videos.id`. */
  videoId: string;
  /** FK to `channels.id`. */
  channelId: string;
  author: string;
  /** Plain text; `textFormat=plainText` at fetch time. */
  text: string;
  /** ISO-8601 UTC. */
  publishedAt: string;
  likeCount: number;
  /** Denormalized: `1` iff this comment has at least one `TimeAnchor`. */
  hasAnchors: 0 | 1;
  /** ISO-8601 UTC; ADR-0001. */
  fetchedAt: string;
  /** ISO-8601 UTC; computed in the `comments_active` view. */
  expiresAt?: string;
  /** Computed in the `comments_active` view. */
  isExpired?: boolean;
}

/** One matched timestamp inside a comment's text — one row in `time_anchors`. */
export interface TimeAnchor {
  /** FK to `comments.id`. */
  commentId: string;
  /** Seconds offset from the video start. */
  seconds: number;
  /** Original substring, e.g. `'5:32'` or `'1:23:45'`. */
  rawText: string;
  /** Char offset into the parent comment's text. */
  charPosition: number;
}

/** A `CommentRecord` whose text holds ≥ 1 `TimeAnchor`. */
export interface TimestampedComment extends CommentRecord {
  /** Always `1` for this type — the type exists to enforce it. */
  hasAnchors: 1;
}

/** Discriminated union produced by `parseChannelInput` (#T03). */
export type ChannelInput = { kind: 'handle'; value: string } | { kind: 'id'; value: string };

/**
 * One Operator-submitted ingest run tracked in `ingest_requests`.
 * Source: GLOSSARY.md / ADR-0005.
 *
 * `channelInput`, `channelKey`, and `finishedAt` are the stored row's audit
 * fields: the loader (`server/data.ts`) always fills them from D1, but the
 * public status contract and the UI never expose them, so they are optional
 * for consumers constructing fixtures.
 */
export interface IngestRequest {
  /** Request ID assigned at submission. */
  id: string;
  /** Raw operator input, verbatim. */
  channelInput?: string;
  /** Normalized identity: UC… id if derivable, else lowercased `@handle`. */
  channelKey?: string;
  /** Resolved YouTube channel id; `null` until the ingest resolves it. */
  channelId: string | null;
  /** queued → running → done/failed. */
  status: 'queued' | 'running' | 'done' | 'failed';
  /** Videos written so far (0 until the runner reports progress). */
  videosWritten: number;
  /** Comments written so far. */
  commentsWritten: number;
  /** Error message when status is `failed`. */
  error: string | null;
  /** ISO-8601 UTC; set once at submission. */
  createdAt: string;
  /** ISO-8601 UTC; updated by the runner on every progress tick. */
  updatedAt: string;
  /** ISO-8601 UTC; set on done/failed. */
  finishedAt?: string | null;
}
