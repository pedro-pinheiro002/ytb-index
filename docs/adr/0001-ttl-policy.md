# TTL policy for API-key-fetched YouTube data

ytb-index v1 fetches public YouTube data (videos, comments, anchors) using only an API key. Developer Policies III.E.4.d caps storage of such "Non-Authorized Data" at 30 calendar days; we treat that cap as binding — the term is undefined in the policies but the natural reading covers API-key-fetched public data, and the asymmetry of error (cheap column vs. losing API access) is too lopsided to gamble. v1 implements belt-and-suspenders: every public-API-data row carries `fetched_at`; users refresh via `pnpm ingest` (which overwrites); if no refresh happens within 30 days, comment text is replaced with a placeholder at read time so the project can't drift into a ToS violation from a missed refresh.

## Status

accepted

## Considered Options

- **Hard-delete only** — automatic redaction at day 31, no user opt-out. Punitive: users lose data they didn't realize they had to refresh.
- **Refresh-on-demand only** — relies on user memory within 30 days. Brittle; III.E.4.f also requires visibly fresh data, which this option alone doesn't guarantee.
- **Belt and suspenders (chosen)** — hard-delete safety net + refresh-on-demand path. ~1.5× the code of either alone; eliminates the asymmetry of error.

## Consequences

- `fetched_at TEXT NOT NULL` is required on every public-API-data table (`channels`, `videos`, `comments`). Computed `expires_at` is read-time, not stored.
- `pnpm ingest` re-run overwrites all `fetched_at` values for that channel in one transaction. Partial refreshes are out of v1 scope.
- No user-deletion affordance in v1 (single API key, no third-party users in the III.E.4.g sense). v2 introduces one if user accounts ever land.
- UI shows "Last refreshed" on the catalog page; expired comments render a placeholder on the video page; `time_anchors` rows for expired comments stay visible (the anchor existed, the body is redacted).
- Cited by: #10 (wayfinder, this resolution), #8 (schema), #2 (ingest), #6 (spec).
