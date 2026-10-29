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
 * - v2 (spec docs/spec/v2.md, F1 #47): Broadcast fields on `VideoRecord`,
 *   Reply fields on `CommentRecord`, `LiveChatMessage`, and the search
 *   contract (`SearchQuery`, `SearchHit`). New record fields are optional
 *   until every producer writes them. F3a (#49): the Ingest now fills all of
 *   them; they stay optional so hand-built fixtures keep compiling, and the
 *   write model (`db/ingest-writes`) supplies the defaults.
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

/** Whether a VideoRecord is a plain upload or a Broadcast (GLOSSARY.md). */
export type VideoKind = 'upload' | 'broadcast';

/**
 * A stored Broadcast's state: on air, or over. Upcoming Broadcasts are
 * skipped at Ingest and never stored (spec v2 "Classification of Broadcasts").
 */
export type BroadcastState = 'live' | 'ended';

/**
 * One video in the Catalog — one row in `videos` (GLOSSARY.md: VideoRecord);
 * either a plain upload or a Broadcast.
 */
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
  /** `'broadcast'` iff `videos.list` returned `liveStreamingDetails`; DB default `'upload'`. */
  kind?: VideoKind;
  /** Set for a Broadcast; `null` for an upload. */
  broadcastState?: BroadcastState | null;
  /** ISO-8601 UTC; `liveStreamingDetails.actualStartTime`, Broadcasts only. */
  actualStartTime?: string | null;
  /** ISO-8601 UTC; `liveStreamingDetails.actualEndTime`, once a Broadcast ends. */
  actualEndTime?: string | null;
  /**
   * Normalized `title + ' ' + description` (ADR-0010). Ingest always sets it
   * (F3a, #49); when absent, the write model derives it.
   */
  searchText?: string;
}

/**
 * One YouTube comment in the Catalog — one row in `comments` (GLOSSARY.md:
 * CommentRecord), top-level or a Reply (`parentId` set).
 */
export interface CommentRecord {
  /** YouTube comment ID. */
  id: string;
  /** FK to `videos.id`. */
  videoId: string;
  /** FK to `channels.id`. */
  channelId: string;
  author: string;
  /** Author's YouTube channel id (`snippet.authorChannelId.value`); `''` when unknown. */
  authorChannelId?: string;
  /** The parent CommentRecord's id for a Reply; `null` for a top-level CommentRecord. */
  parentId?: string | null;
  /** Plain text; `textFormat=plainText` at fetch time. */
  text: string;
  /**
   * Normalized `text` (ADR-0010). Ingest always sets it (F3a, #49); when
   * absent, the write model derives it.
   */
  searchText?: string;
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

/**
 * One message posted to a Broadcast's live chat while it was on air — one row
 * in `live_chat_messages` (GLOSSARY.md: LiveChatMessage; ADR-0009). Only text
 * messages and Super Chat comments are stored; no TimeAnchors are detected.
 */
export interface LiveChatMessage {
  /** YouTube liveChatMessage id. */
  id: string;
  /** FK to `videos.id` (the Broadcast). */
  videoId: string;
  /** FK to `channels.id`. */
  channelId: string;
  /** `authorDetails.displayName`. */
  author: string;
  /** `authorDetails.channelId`. */
  authorChannelId: string;
  /** Message text (redacted in `live_chat_messages_active` once expired). */
  text: string;
  /** ISO-8601 UTC; `snippet.publishedAt`. */
  publishedAt: string;
  /** `max(0, floor((publishedAt − actualStartTime) / 1000))`. */
  offsetSeconds: number;
  /** ISO-8601 UTC; ADR-0001. */
  fetchedAt: string;
  /** ISO-8601 UTC; computed in the `live_chat_messages_active` view. */
  expiresAt?: string;
  /** Computed in the `live_chat_messages_active` view. */
  isExpired?: boolean;
}

/**
 * What a SearchHit is: a top-level CommentRecord, a Reply, a LiveChatMessage,
 * or a VideoRecord (GLOSSARY.md: SearchHit; spec v2 `kind` param).
 */
export type SearchHitKind = 'comment' | 'reply' | 'chat' | 'video';

/** Order of SearchHits; LiveChatMessages and videos sort as 0 likes. */
export type SearchSort = 'newest' | 'oldest' | 'likes';

/**
 * A Visitor's combination of terms, date range, author and record kinds,
 * evaluated against the Catalog alone (GLOSSARY.md: SearchQuery; spec v2
 * "SearchQuery contract", ADR-0010). Already validated: dates are
 * `YYYY-MM-DD`, inclusive.
 */
export interface SearchQuery {
  /** Normalized terms, all of which must match `search_text`; at most 8. */
  terms: string[];
  /** Record kinds to search; default `comment`, `reply`, `chat`. */
  kinds: SearchHitKind[];
  /** `UC…` Channel scope; `null` for every Channel. */
  channelId: string | null;
  /** Earliest hit `publishedAt` day (UTC), inclusive. */
  from: string | null;
  /** Latest hit `publishedAt` day (UTC), inclusive. */
  to: string | null;
  /** Earliest source-video `publishedAt` day (UTC), inclusive. */
  videoFrom: string | null;
  /** Latest source-video `publishedAt` day (UTC), inclusive. */
  videoTo: string | null;
  /** `UC…` (24 chars) → exact `authorChannelId`; otherwise normalized display-name substring. */
  author: string | null;
  /** Only CommentRecords with TimeAnchors (and all LiveChatMessages). */
  timestamped: boolean;
  /** Hit order; default `newest`. */
  sort: SearchSort;
  /** 1-based page, 25 hits per page, at most 40. */
  page: number;
}

/**
 * One CommentRecord, LiveChatMessage or VideoRecord matched by a SearchQuery,
 * together with where it points in its source video (GLOSSARY.md: SearchHit;
 * spec v2 "SearchHit links").
 */
export interface SearchHit {
  /** Which record kind matched. */
  kind: SearchHitKind;
  /** The source video (the VideoRecord itself for `kind = 'video'`). */
  videoId: string;
  /** The source video's title. */
  videoTitle: string;
  /** The matched record's id: comment, message or video id. */
  recordId: string;
  /** Author display name; `''` for a video. */
  author: string;
  /** Author's channel id; `''` when unknown or for a video. */
  authorChannelId: string;
  /** ISO-8601 UTC; the hit's own `publishedAt`. */
  publishedAt: string;
  /** Matched text (comment/message text, or the video title). */
  text: string;
  /** Likes; `0` for LiveChatMessages. */
  likeCount: number;
  /** TimeAnchor seconds of a CommentRecord, in text order; `[]` otherwise. */
  anchorSeconds: number[];
  /** A LiveChatMessage's offset in seconds; `null` otherwise. */
  offsetSeconds: number | null;
  /** The parent CommentRecord's id for a Reply; `null` otherwise. */
  parentId: string | null;
  /**
   * The parent CommentRecord's author for a Reply, so the hit can say which
   * comment it answers (spec v2 story 50); `null` otherwise or when the
   * parent is not in the Catalog. Always set by `searchCatalog` (F4 #50).
   */
  parentAuthor?: string | null;
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
  /** Top-level CommentRecords written so far (Replies are `repliesWritten`). */
  commentsWritten: number;
  /** Error message when status is `failed`. */
  error: string | null;
  /** ISO-8601 UTC; set once at submission. */
  createdAt: string;
  /** ISO-8601 UTC; updated by the runner on every progress tick. */
  updatedAt: string;
  /** ISO-8601 UTC; set on done/failed. */
  finishedAt?: string | null;
  /** Who pays for the Ingest: the repo key or an OperatorKey (ADR-0007). DB default `'repo'`. */
  keySource?: 'repo' | 'operator';
  /** Whether LiveChatMessages of on-air Broadcasts are captured (ADR-0009). */
  captureLiveChat?: boolean;
  /** Replies written so far. */
  repliesWritten?: number;
  /** LiveChatMessages written so far. */
  chatMessagesWritten?: number;
  /** Videos skipped and not stored (upcoming Broadcasts). */
  skippedVideos?: number;
  /** Quota units spent by the run so far. */
  quotaUsed?: number;
}
