-- ytb-index v2 schema — operator-triggered ingest requests (ADR-0005).
--
-- One row per IngestRequest (GLOSSARY.md): the Operator's instruction,
-- submitted through POST /api/ingest, for one ingest run of one Channel.
-- Progresses queued -> running -> done/failed. The Worker API writes the
-- initial `queued` row and the `failed` row when the GitHub dispatch call
-- fails; the Actions runner (on: repository_dispatch) updates status, counts,
-- and errors through the same D1 HTTP API.
--
-- Reads are public (GET /api/ingest/status and the operator UI); every write
-- is gated by the operator token (ADR-0005).
--
-- `channel_key` is the normalized identity used to enforce one active request
-- per Channel: the resolved UC... id when the input is an id/URL, otherwise
-- the lowercased @handle. `channel_id` stays NULL until an ingest resolves
-- the real id. No FK on `channel_id`: the request exists before the channel
-- row does.
CREATE TABLE IF NOT EXISTS ingest_requests (
    id                TEXT PRIMARY KEY,      -- uuid (crypto.randomUUID)
    channel_input     TEXT NOT NULL,         -- raw operator input, verbatim
    channel_key       TEXT NOT NULL,         -- UC... id if derivable, else lowercased @handle
    channel_id        TEXT,                  -- resolved YouTube channel id (UC...), set by the runner
    status            TEXT NOT NULL CHECK (status IN ('queued','running','done','failed')),
    videos_written    INTEGER NOT NULL DEFAULT 0,
    comments_written  INTEGER NOT NULL DEFAULT 0,
    error             TEXT,                  -- failure detail; NULL while healthy
    created_at        TEXT NOT NULL,         -- ISO-8601 UTC
    updated_at        TEXT NOT NULL,         -- ISO-8601 UTC, set on every status write
    finished_at       TEXT                   -- ISO-8601 UTC, set on done/failed
);

-- Status/history reads, newest-first.
CREATE INDEX IF NOT EXISTS idx_ingest_requests_status_created
    ON ingest_requests(status, created_at);
-- Per-channel history and the active-request lookup.
CREATE INDEX IF NOT EXISTS idx_ingest_requests_channel_key
    ON ingest_requests(channel_key);
-- DB-level "one active IngestRequest per Channel" (ADR-0005). A second
-- concurrent trigger hits this constraint and is rejected with 409, not
-- queued; the API re-reads the winning row and returns its id.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ingest_requests_active_channel
    ON ingest_requests(channel_key)
    WHERE status IN ('queued', 'running');
