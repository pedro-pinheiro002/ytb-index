-- ytb-index v1 schema
-- Source of truth for the catalog persistence layer.
-- See wayfinder ticket #8 for the design decisions:
--   https://github.com/pedro-pinheiro002/ytb-index/issues/8
-- Cross-references:
--   ADR-0001 (TTL policy, fetched_at + 30-day read-time redaction):
--     docs/adr/0001-ttl-policy.md
--   #3 — Glossary: Channel, Catalog, VideoRecord, CommentRecord, TimeAnchor
--   #7 — TimeAnchor detection algorithm (time_anchors row shape)
--   #9 — YouTube Data API v3 facts (endpoints, quota)
--   #2 — Ingest pipeline (row contents; partial overwrites on re-run)
--
-- Glossary → table mapping:
--   Channel          -> channels   (one row per YouTube channel)
--   VideoRecord      -> videos     (one row per uploaded video)
--   CommentRecord    -> comments   (one row per top-level comment)
--   TimeAnchor       -> time_anchors (one row per detected timestamp)
--   Catalog          -> implicit: every row for one channel shares fetched_at
--                       and is overwritten in one transaction by pnpm ingest.
--                       No catalogs table (out-of-scope per Q1 of #8).
--   TimestampedComment -> derived at read time: comment WHERE has_anchors = 1.

-- Connection pragmas (`foreign_keys`, `journal_mode = WAL`) are local-driver
-- settings, applied in src/db/sqlite.ts — never in shared migration SQL: they
-- are per-connection and D1 does not support them.

-- =========================================================================
-- channels
-- =========================================================================
-- One row per YouTube channel we ran an ingest for.
-- Populated by step 4-5 of the ingest pipeline (#2).
CREATE TABLE IF NOT EXISTS channels (
    id                  TEXT PRIMARY KEY,        -- YouTube channel ID (UC...)
    title               TEXT NOT NULL,           -- snippet.title
    uploads_playlist_id TEXT NOT NULL,           -- contentDetails.relatedPlaylists.uploads
    fetched_at          TEXT NOT NULL            -- ISO-8601 UTC, set on every ingest
);

-- =========================================================================
-- videos
-- =========================================================================
-- One row per uploaded video on a channel.
-- Populated by step 7 of the ingest pipeline (videos.list enrichment in
-- batches of 50).
CREATE TABLE IF NOT EXISTS videos (
    id                TEXT PRIMARY KEY,          -- YouTube video ID
    channel_id        TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    title             TEXT NOT NULL,
    description       TEXT NOT NULL DEFAULT '',
    published_at      TEXT NOT NULL,             -- ISO-8601 UTC, snippet.publishedAt
    thumbnail_url     TEXT NOT NULL,             -- best thumbnail URL; bytes are NOT stored (III.E.1)
    duration_iso8601  TEXT NOT NULL DEFAULT '',  -- contentDetails.duration (ISO-8601)
    view_count        INTEGER NOT NULL DEFAULT 0,
    like_count        INTEGER NOT NULL DEFAULT 0,
    comment_count     INTEGER NOT NULL DEFAULT 0,
    fetched_at        TEXT NOT NULL
);

-- Single-column FK index for join lookups.
CREATE INDEX IF NOT EXISTS idx_videos_channel_id ON videos(channel_id);

-- Composite for the catalog page: list videos for one channel sorted newest-first.
-- The only sort we know runs on every catalog page load (#8 Q3).
CREATE INDEX IF NOT EXISTS idx_videos_channel_published ON videos(channel_id, published_at DESC);

-- =========================================================================
-- comments
-- =========================================================================
-- One row per top-level comment we fetched (replies are out of v1 scope).
-- Populated by step 8 of the ingest pipeline (commentThreads.list paging).
-- text is stored verbatim using textFormat=plainText at fetch time; the
-- read-time view `comments_active` handles TTL redaction per ADR-0001.
CREATE TABLE IF NOT EXISTS comments (
    id            TEXT PRIMARY KEY,            -- YouTube comment ID
    video_id      TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    channel_id    TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    author        TEXT NOT NULL DEFAULT '',    -- snippet.authorDisplayName
    text          TEXT NOT NULL,               -- plain text (textFormat=plainText)
    published_at  TEXT NOT NULL,               -- ISO-8601 UTC, snippet.publishedAt
    like_count    INTEGER NOT NULL DEFAULT 0,
    has_anchors   INTEGER NOT NULL DEFAULT 0,  -- denormalized: 1 if any time_anchors, else 0
    fetched_at    TEXT NOT NULL
);

-- Single-column FK indices.
CREATE INDEX IF NOT EXISTS idx_comments_video_id ON comments(video_id);
CREATE INDEX IF NOT EXISTS idx_comments_channel_id ON comments(channel_id);
-- (No composite on comments(video_id, published_at DESC): video page renders
--  a few-dozen comments per video, sort-in-memory is fine for v1; revisit in v2
--  if any single video accumulates thousands of comments.)

-- =========================================================================
-- time_anchors
-- =========================================================================
-- One row per matched timestamp in a comment's text (algorithm in #7).
-- Rows are derived from the parent comment; if a comment is deleted, the
-- cascade clears its anchors. Anchor freshness follows the parent comment's
-- fetched_at (ADR-0001 — no separate fetched_at on this table).
CREATE TABLE IF NOT EXISTS time_anchors (
    comment_id     TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
    seconds        INTEGER NOT NULL,
    raw_text       TEXT NOT NULL,               -- matched substring, e.g. '5:32' or '1:23:45'
    char_position  INTEGER NOT NULL,            -- char offset in original comment text
    PRIMARY KEY (comment_id, seconds)
);
-- (No extra index needed for v1 reads: anchor-by-comment uses the PK prefix;
--  cross-comment queries by seconds aren't a v1 access pattern.)

-- =========================================================================
-- Read-time TTL redaction view (ADR-0001)
-- =========================================================================
-- expires_at = fetched_at + 30 calendar days. If now > expires_at, text is
-- replaced with a placeholder. The underlying `comments` rows are never
-- mutated; a fresh `pnpm ingest` resets fetched_at and the comment
-- reappears in full.
--
-- Application code reads comments via this view, never the raw table.
-- time_anchors rows for expired comments remain visible (the anchor
-- existed; the body is redacted).
CREATE VIEW IF NOT EXISTS comments_active AS
    SELECT
        id,
        video_id,
        channel_id,
        author,
        CASE
            WHEN datetime(fetched_at, '+30 days') < datetime('now')
                THEN '[Comment text expired — refresh to recover]'
            ELSE text
        END                                              AS text,
        published_at,
        like_count,
        has_anchors,
        fetched_at,
        datetime(fetched_at, '+30 days')                 AS expires_at,
        (datetime(fetched_at, '+30 days') < datetime('now')) AS is_expired
    FROM comments;