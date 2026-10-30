# Catalog search uses a normalized text column and LIKE, not FTS5

A SearchQuery runs over the Catalog only, never `search.list` (it has its own 100-calls/day bucket, and comments are not in YouTube's search index anyway). FTS5 runs on D1, but Cloudflare documents that a database containing virtual tables cannot be exported (the workaround is to drop them, export, and recreate them), and there is an unconfirmed report of an export that left an FTS5 database inaccessible. A token table, the other indexed option, multiplies write rows by about 15 per comment, and ADR-0005 already names D1's 100k rows written per day as the binding cap. We therefore store one `search_text` column per searchable record: lowercase, diacritics stripped, whitespace collapsed, normalized at Ingest. Each term becomes `search_text LIKE '%' || ? || '%' ESCAPE '\'`, and the terms are ANDed. Date, author and kind filters, plus the Channel scope, use ordinary indexes and narrow the rows the LIKE has to scan. The SQL is identical on better-sqlite3 and D1, adds no write amplification, and does not affect export.

## Status

accepted. Amended by ADR-0011: `/search` may also show a separate LiveSearch section that runs in the Operator's browser; the SearchQuery itself still reads the Catalog only.

## Considered Options

- **FTS5 virtual tables**: rejected for now. They break `wrangler d1 export`, and the external-content and trigger setup needed to keep them in step with upserts and the TTL view is engine-specific in practice. Revisit if search reads become the binding cap.
- **Token table (`token`, `record_id`) with prefix ranges**: rejected. About 15× write rows per record against a 100k/day free write cap, and every re-Ingest has to delete and re-insert tokens across non-atomic remote chunks (ADR-0003).
- **Plain `LIKE` on `text`**: rejected. SQLite's `lower()` and `LIKE` fold ASCII only, so "Ação" would never match "acao".
- **Normalized `search_text` + LIKE (chosen)**.

## Consequences

- One normalizer, in `src/db` (both `ingest` and `server` may import `db`), is used for writing `search_text` and for normalizing query terms. A single shared function keeps writes and queries from drifting apart.
- TTL (ADR-0001): searches read through `comments_active` / `live_chat_messages_active`, where `search_text` is `''` once a record expires, so expired text can neither match nor be shown. The stored column follows the same rule as the stored `text`: kept, unreadable after 30 days, refreshed by the next Ingest.
- Cost: a term search scans the Channel's rows that pass the other filters. D1 bills rows read (5M/day free); a 50k-comment Channel allows about 100 unfiltered term searches per day. Pages are offset-paginated, 25 per page, with a maximum offset. If a real Channel gets near the cap, the next step is FTS5 with drop-before-export tooling, in a new ADR.
- Rows ingested before migration 0003 get an ASCII-only `lower(text)` backfill, and the next Ingest rewrites them with the full normalizer.
