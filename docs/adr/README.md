# Architecture Decision Records

Read the ADRs that touch the area you are about to change; contradicting one
is allowed only when the change says so explicitly (see
`docs/agents/domain.md`). New ADRs take the next number and follow the shape of
the existing ones: a one-paragraph decision, then Status, then Considered
Options.

| ADR                                                      | Decision                                                                                     | Status                                       | Touches                                                                              |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------ |
| [0001](0001-ttl-policy.md)                               | Comment text expires 30 days after `fetched_at`; redacted at read time, refreshed by Ingest. | accepted, amended (Replies, live chat, search) | `migrations/` (`comments_active`), `src/db/queries.ts`, `src/server/`                |
| [0002](0002-deploy-read-server-on-workers-d1.md)         | The read path runs as a Hono Worker over D1.                                                 | accepted, amended by 0007                    | `src/worker.ts`, `src/server/`, `src/db/` (`Executor`), `wrangler.jsonc`             |
| [0003](0003-local-ingest-writes-remote-d1.md)            | Ingest stays a CLI; `--remote` writes D1 over HTTP in best-effort, idempotent chunks.        | accepted, partially superseded by 0005, amended by 0007 | `src/cli/`, `src/ingest/`, `src/db/d1-http.ts`                                       |
| [0004](0004-public-repo-for-rulesets.md)                 | The repo is public so branch rulesets work on the free plan.                                 | accepted                                     | repository settings; never commit secrets                                            |
| [0005](0005-fe-triggered-ingest-on-github-actions.md)    | The web app queues IngestRequests; GitHub Actions runs the Ingest.                           | accepted, amended by 0008                    | `src/server/api/ingest.ts`, `.github/workflows/ingest.yml`, `src/cli/status.ts`      |
| [0006](0006-sentry-triggered-repair-agent-on-actions.md) | Sentry issues wake a repair agent on Actions that may only open a draft PR on `src/`.        | accepted, amended (verifier is `pnpm check`; model via Claude Code CLI) | `src/agent/`, `src/server/api/agent-hook.ts`, `.github/workflows/agent-diagnose.yml` |
| [0007](0007-operator-supplies-own-api-key.md) | The Operator pastes their own API key, checked with a 1-unit probe; no Google sign-in. | accepted | `src/server/api/`, `src/server/ssr.tsx` |
| [0008](0008-sealed-operator-key-to-actions-runner.md) | The OperatorKey reaches the Actions runner sealed with RSA-OAEP; nothing is stored. | accepted | `src/server/api/ingest.ts`, `src/cli/`, `.github/workflows/ingest.yml`, `wrangler.jsonc` |
| [0009](0009-live-chat-official-api-active-broadcasts-only.md) | LiveChatMessages come from the official API, only while a Broadcast is on air. | accepted | `src/yt/`, `src/ingest/`, `migrations/` |
| [0010](0010-catalog-search-normalized-like-not-fts5.md) | Catalog search uses a normalized `search_text` column with LIKE, not FTS5. | accepted | `src/db/`, `src/server/routes/`, `migrations/` |
