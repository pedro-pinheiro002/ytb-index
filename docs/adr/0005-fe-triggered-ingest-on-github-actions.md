# FE-triggered ingest on GitHub Actions; the web app becomes the operator's only surface

The web app becomes the operator's only surface: a token-gated trigger route creates an IngestRequest (queued → running → done/failed, polled from D1) and fires a GitHub `repository_dispatch`, and a free public-repo Actions runner executes the existing `pnpm ingest <channel> --remote` pipeline verbatim. Every platform-native alternative became free in 2026 (Queues, Workflows, Durable Object alarms), but each means porting `src/yt` into the Workers runtime under its free 10 ms/invocation CPU cap — while Actions keeps the ADR-0002/0003 boundary (the server never touches the ingest pipeline or the YouTube key) at zero porting cost, which is why ADR-0003's deferred "scheduled Actions" option wins. The CLI stays as the dev/test/offline/repair fallback, and this reverses ADR-0003's secret-location line: `YOUTUBE_API_KEY` and the D1 token move from the local `.env` to encrypted GitHub repo secrets, joined by a fine-grained PAT (Contents: write) held as a Worker secret for the dispatch call.

## Status

accepted — amended by ADR-0008: an IngestRequest may carry a sealed OperatorKey, and the `YOUTUBE_API_KEY` repo secret becomes the fallback used when it does not.

## Considered Options

- **Cloudflare Workflows (free 2026)** — 3,000 steps/day, 1,024 steps/instance; a full 9,500-quota-unit day ≈ 190 steps fits. Rejected: ports `src/yt` into Workers under 10 ms CPU/step and 50 subrequests/step with 3-day state retention — real risk for a parse-heavy pipeline; the honest runner-up if the GitHub dependency must go.
- **Queues (free Feb 2026)** — 10k ops/day ≈ ~3,300 deliveries; same porting problem plus producer/consumer/DLQ machinery and 24 h retention.
- **Durable Object alarm loop** — no PAT, platform-simplest; same porting problem, SQLite-only on the free tier.
- **GitHub Actions via `repository_dispatch` (chosen)** — ADR-0003's deferred v2 option, picked up FE-triggered: public repo → free standard runners, 6 h/job, no CPU/subrequest limits; costs one fine-grained PAT and the secret relocation.

## Consequences

- One workflow file on the default branch, `on: repository_dispatch` with a private `event_type`; the runner checks out, runs `pnpm ingest <channel> --remote` with repo secrets, and updates the IngestRequest (running → done/failed, counts, errors) through the same D1 HTTP token — keeping the existing chunked multi-statement write shape, which also stays clear of the 1,200 req/5 min global Cloudflare API limit.
- Secrets inventory: the Worker holds the shared operator token + the GitHub PAT; the repo holds `YOUTUBE_API_KEY` + the D1 token; the deploy pipeline stays `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` (ADR-0002). Fork-triggered workflows never receive secrets; repo collaborators with write access could read them — moot for a sole-operator repo; the PAT scope is Contents: write only.
- Reads stay public; every write is gated by the operator token (entered once, browser-stored, sent only on the trigger call). One active IngestRequest per Channel — a second trigger is rejected, not queued.
- Status is polled, not streamed: the operator's status area reads the IngestRequest from D1; visitors get ADR-0001 "Last refreshed" freshness and no status UI.
- D1's free 100k rows written/day is the binding cap ahead of compute (ADR-0003 already noted a typical single-Channel run fits; a maximal 9,500-unit day could reach ~950k comment rows): a capped run fails visibly in the status area, and the idempotent-upsert repair is re-triggering the next day. No per-run comment cap in v1 — the failure mode is honest, not silent.
- CLI fallback unchanged: the local better-sqlite3 executor keeps dev/tests/offline/repair (ADR-0002/0003); the FE stays self-sufficient with the workstation off, since dispatch is event-driven (no cron, no 60-day idle auto-disable).
- ADR-0001's refresh path is touched: users refresh by triggering an ingest from the web app; the 30-day redaction safety net is unchanged.
- A run that never reports a final status (runner killed at the 6 h `timeout-minutes` cap, crashed, or a dispatch never picked up) would otherwise hold the one-active-per-Channel slot forever. `POST /api/ingest` therefore marks an active request for that Channel as `failed` ("stale: …") when its `updated_at` is more than 6 h old, before applying the 409 check. A `running` row that old cannot belong to a live job; a `queued` row that old is treated as never picked up. Edge: a runner that starts after that cutoff still writes its status to the already-failed row.
