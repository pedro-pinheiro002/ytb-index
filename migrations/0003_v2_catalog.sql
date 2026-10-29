-- ytb-index v2 schema — Broadcasts, Replies, LiveChatMessages, search_text,
-- and the v2 IngestRequest fields. New file: 0001/0002 are already applied in
-- production and are never edited.
-- Source: docs/spec/v2.md "Schema: migration 0003_v2_catalog.sql", ticket F1:
--   https://github.com/pedro-pinheiro002/ytb-index/issues/47
-- Cross-references:
--   ADR-0001 (TTL policy, fetched_at + 30-day read-time redaction):
--     docs/adr/0001-ttl-policy.md
--   ADR-0009 (live chat from the official API, on-air Broadcasts only):
--     docs/adr/0009-live-chat-official-api-active-broadcasts-only.md
--   ADR-0010 (Catalog search over a normalized search_text column + LIKE):
--     docs/adr/0010-catalog-search-normalized-like-not-fts5.md
--
-- Glossary → schema mapping (GLOSSARY.md):
--   Broadcast        -> videos.kind = 'broadcast' (+ broadcast_state, actual_*_time)
--   Reply            -> comments row with parent_id set (one level only)
--   LiveChatMessage  -> live_chat_messages
--   SearchQuery      -> LIKE over search_text in the *_active views (ADR-0010)
--
-- Portable SQL only (D1 and better-sqlite3): no pragmas. A column added with
-- ALTER TABLE ... REFERENCES must default to NULL, which parent_id does.

-- =========================================================================
-- videos: Broadcast classification + search_text
-- =========================================================================
-- kind: 'upload' when videos.list has no liveStreamingDetails, else
-- 'broadcast'. Upcoming Broadcasts are skipped at Ingest, never stored, so
-- broadcast_state is NULL (upload) or 'live' / 'ended'.
ALTER TABLE videos ADD COLUMN kind TEXT NOT NULL DEFAULT 'upload'
    CHECK (kind IN ('upload', 'broadcast'));
ALTER TABLE videos ADD COLUMN broadcast_state TEXT
    CHECK (broadcast_state IN ('live', 'ended'));
ALTER TABLE videos ADD COLUMN actual_start_time TEXT;   -- liveStreamingDetails.actualStartTime
ALTER TABLE videos ADD COLUMN actual_end_time TEXT;     -- liveStreamingDetails.actualEndTime
-- Normalized title + description (src/db/search-text.ts, ADR-0010).
ALTER TABLE videos ADD COLUMN search_text TEXT NOT NULL DEFAULT '';

-- =========================================================================
-- comments: Replies, author channel, search_text
-- =========================================================================
ALTER TABLE comments ADD COLUMN author_channel_id TEXT NOT NULL DEFAULT '';  -- snippet.authorChannelId.value
-- NULL for a top-level CommentRecord; the parent's id for a Reply.
ALTER TABLE comments ADD COLUMN parent_id TEXT REFERENCES comments(id) ON DELETE CASCADE;
-- Normalized text (ADR-0010); redacted to '' by comments_active once expired.
ALTER TABLE comments ADD COLUMN search_text TEXT NOT NULL DEFAULT '';

-- Search filters (ADR-0010): Channel scope + date range, author, Reply lookup.
CREATE INDEX IF NOT EXISTS idx_comments_channel_published ON comments(channel_id, published_at);
CREATE INDEX IF NOT EXISTS idx_comments_author_channel_id ON comments(author_channel_id);
CREATE INDEX IF NOT EXISTS idx_comments_parent_id ON comments(parent_id);

-- =========================================================================
-- live_chat_messages (ADR-0009)
-- =========================================================================
-- One row per LiveChatMessage captured while its Broadcast was on air. Only
-- textMessageEvent and superChatEvent.userComment are stored. Non-Authorized
-- Data like comments: fetched_at drives 30-day redaction (ADR-0001).
CREATE TABLE IF NOT EXISTS live_chat_messages (
    id                 TEXT PRIMARY KEY,         -- YouTube liveChatMessage id
    video_id           TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    channel_id         TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    author             TEXT NOT NULL DEFAULT '', -- authorDetails.displayName
    author_channel_id  TEXT NOT NULL DEFAULT '', -- authorDetails.channelId
    text               TEXT NOT NULL,            -- displayed message text
    published_at       TEXT NOT NULL,            -- ISO-8601 UTC, snippet.publishedAt
    offset_seconds     INTEGER NOT NULL,         -- max(0, floor(publishedAt - actualStartTime))
    search_text        TEXT NOT NULL DEFAULT '', -- normalized text (ADR-0010)
    fetched_at         TEXT NOT NULL             -- ISO-8601 UTC
);

-- Video page: a Broadcast's chat in stream order.
CREATE INDEX IF NOT EXISTS idx_live_chat_messages_video_offset
    ON live_chat_messages(video_id, offset_seconds);
-- Search filters: Channel scope + date range, author.
CREATE INDEX IF NOT EXISTS idx_live_chat_messages_channel_published
    ON live_chat_messages(channel_id, published_at);
CREATE INDEX IF NOT EXISTS idx_live_chat_messages_author_channel_id
    ON live_chat_messages(author_channel_id);

-- =========================================================================
-- Read-time TTL redaction views (ADR-0001, ADR-0010)
-- =========================================================================
-- comments_active is recreated so it exposes the v2 columns. Every v1 column
-- keeps its name and meaning; search_text is '' once expired, so an expired
-- CommentRecord can neither match a SearchQuery nor be shown.
DROP VIEW IF EXISTS comments_active;
CREATE VIEW comments_active AS
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
        (datetime(fetched_at, '+30 days') < datetime('now')) AS is_expired,
        author_channel_id,
        parent_id,
        CASE
            WHEN datetime(fetched_at, '+30 days') < datetime('now')
                THEN ''
            ELSE search_text
        END                                              AS search_text
    FROM comments;

-- Same redaction rule for LiveChatMessages (ADR-0009 consequences).
DROP VIEW IF EXISTS live_chat_messages_active;
CREATE VIEW live_chat_messages_active AS
    SELECT
        id,
        video_id,
        channel_id,
        author,
        author_channel_id,
        CASE
            WHEN datetime(fetched_at, '+30 days') < datetime('now')
                THEN '[Message text expired — refresh to recover]'
            ELSE text
        END                                              AS text,
        published_at,
        offset_seconds,
        CASE
            WHEN datetime(fetched_at, '+30 days') < datetime('now')
                THEN ''
            ELSE search_text
        END                                              AS search_text,
        fetched_at,
        datetime(fetched_at, '+30 days')                 AS expires_at,
        (datetime(fetched_at, '+30 days') < datetime('now')) AS is_expired
    FROM live_chat_messages;

-- =========================================================================
-- ingest_requests: OperatorKey source, live-chat opt-in, v2 counters
-- =========================================================================
-- key_source: 'repo' (repo YOUTUBE_API_KEY) or 'operator' (OperatorKey,
-- ADR-0007/0008). capture_live_chat: 0/1 opt-in (ADR-0009).
ALTER TABLE ingest_requests ADD COLUMN key_source TEXT NOT NULL DEFAULT 'repo'
    CHECK (key_source IN ('repo', 'operator'));
ALTER TABLE ingest_requests ADD COLUMN capture_live_chat INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingest_requests ADD COLUMN replies_written INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingest_requests ADD COLUMN chat_messages_written INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingest_requests ADD COLUMN skipped_videos INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingest_requests ADD COLUMN quota_used INTEGER NOT NULL DEFAULT 0;

-- =========================================================================
-- Backfill (ADR-0010)
-- =========================================================================
-- ASCII-only best effort: SQLite's lower() folds ASCII only. The next Ingest
-- rewrites search_text with the full normalizer.
UPDATE comments SET search_text = lower(text);
UPDATE videos SET search_text = lower(title || ' ' || description);
