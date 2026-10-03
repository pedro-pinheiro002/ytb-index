# Ingest stays a local CLI, writing the remote Catalog via D1's HTTP API

Ingest is an unbounded, sequential YouTube-Data-API paging run (wall-time in minutes, self-capped at 9500 quota units/day) — far beyond Workers' free 10 ms CPU per invocation; chunking it into Queues/Workflows/Cron is real infrastructure for a single-operator tool. We keep `pnpm ingest` on the workstation; production writes go to the remote D1 database through its HTTP API as an atomic batch, matching ADR-0001's all-or-nothing refresh.

## Status

accepted

## Considered Options

- **Ingest inside Workers (Cron + Queues/Workflows chunking)** — rejected: checkpointing machinery for zero v1 value; the quota cap already bounds a run.
- **Scheduled GitHub Actions ingest** — deferred, not rejected: the natural v2 automation; costs the YouTube key and a D1 token as repo secrets. Owner chose manual cadence for v1.
- **Local CLI, remote writes (chosen)** — zero new infrastructure; secrets stay in the local `.env`.

## Consequences

- One new local secret (D1 API token in `.env`, gitignored) next to `YOUTUBE_API_KEY`. Neither ever enters the repo or CI; the deploy pipeline only holds `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`.
- Catalog freshness is manual. ADR-0001 makes staleness safe: past 30 days unrefreshed, comment text redacts to a placeholder at read time — the failure mode is degraded pages, not a ToS violation.
- A local-file ingest mode stays available (the better-sqlite3 executor) for dev and tests.
- A typical single-Channel run fits D1's free 100k rows written/day; the 9500-unit quota cap is the first wall in practice for a very large channel.
