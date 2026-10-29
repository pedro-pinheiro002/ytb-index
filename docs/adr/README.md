# Architecture Decision Records

Read the ADRs that touch the area you are about to change; contradicting one
is allowed only when the change says so explicitly (see
`docs/agents/domain.md`). New ADRs take the next number and follow the shape of
the existing ones: a one-paragraph decision, then Status, then Considered
Options.

| ADR                                                      | Decision                                                                                     | Status                                       | Touches                                                                              |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------ |
| [0001](0001-ttl-policy.md)                               | Comment text expires 30 days after `fetched_at`; redacted at read time, refreshed by Ingest. | accepted                                     | `migrations/` (`comments_active`), `src/db/queries.ts`, `src/server/`                |
| [0002](0002-deploy-read-server-on-workers-d1.md)         | The read path runs as a Hono Worker over D1.                                                 | accepted                                     | `src/worker.ts`, `src/server/`, `src/db/` (`Executor`), `wrangler.jsonc`             |
| [0003](0003-local-ingest-writes-remote-d1.md)            | Ingest stays a CLI; `--remote` writes D1 over HTTP in best-effort, idempotent chunks.        | accepted, partially superseded by 0005       | `src/cli/`, `src/ingest/`, `src/db/d1-http.ts`                                       |
| [0004](0004-public-repo-for-rulesets.md)                 | The repo is public so branch rulesets work on the free plan.                                 | accepted                                     | repository settings; never commit secrets                                            |
| [0005](0005-fe-triggered-ingest-on-github-actions.md)    | The web app queues IngestRequests; GitHub Actions runs the Ingest.                           | accepted                                     | `src/server/api/ingest.ts`, `.github/workflows/ingest.yml`, `src/cli/status.ts`      |
| [0006](0006-sentry-triggered-repair-agent-on-actions.md) | Sentry issues wake a repair agent on Actions that may only open a draft PR on `src/`.        | accepted, amended (verifier is `pnpm check`) | `src/agent/`, `src/server/api/agent-hook.ts`, `.github/workflows/agent-diagnose.yml` |
