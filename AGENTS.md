# AGENTS.md

ytb-index ingests one YouTube Channel into a Catalog (SQLite locally, D1 in
production) and serves it as SSR HTML from a Hono app, on Node or on a
Cloudflare Worker. Spec: `docs/spec/v1.md`. Vocabulary: `GLOSSARY.md`.

## Commands

- `pnpm install`: Node 24 and pnpm 9 (see `.nvmrc`, `packageManager`).
- `pnpm check`: typecheck + test + format:check + Worker bundle. **This is the
  definition of green.** CI runs exactly this, and so does the repair agent.
- `pnpm exec tsx --test src/yt/anchors.test.ts`: run one test file.
- `pnpm format`: fix formatting (Prettier, no ESLint).
- `pnpm dev` (Node, :3000) / `pnpm dev:worker` (Worker, :8787).

Tests are co-located `*.test.ts` files on `node:test` + `node:assert/strict`,
with no network: inject the existing seams (`transport`, `now`, `writer`,
`quota`, `DiagnoseDeps`) instead of mocking modules.

## Module map

| Path            | Owns                                                                 |
| --------------- | -------------------------------------------------------------------- |
| `src/shared/`   | Domain types (`Channel`, `VideoRecord`, `CommentRecord`, `TimeAnchor`) |
| `src/yt/`       | YouTube Data API client, quota, channel input parsing, TimeAnchor detection |
| `src/db/`       | `Executor` interface, portable SQL, SQLite / D1 / D1 HTTP drivers     |
| `src/cli/`      | The Ingest pipeline entry (`pnpm ingest`), status reporting           |
| `src/server/`   | Hono app, SSR routes, operator ingest API, Sentry agent hook         |
| `src/worker.ts` | Worker entry: the server app over the D1 binding                      |
| `src/agent/`    | Sentry-triggered repair agent run in Actions (ADR-0006)               |
| `migrations/`   | D1/SQLite schema, applied in order                                    |

<!-- agent-rules:start -->

## Boundaries (enforced by `src/architecture.test.ts`)

- `shared` imports nothing; `yt` and `db` import only `shared`.
- `server` imports only `db` and `shared`, never `yt` or `cli` (ADR-0002/0003).
- The Worker import graph (`src/worker.ts` and everything it reaches) has no
  `node:*`, `better-sqlite3`, `@hono/node-server` or `dotenv`, and never reads
  `process.env`. `nodejs_compat` would hide such imports from the bundler, so
  the test is the guard.
- In `src/db`, only `sqlite.ts` may touch Node.
- `process.env` is read only in entry points: `src/cli`, `src/agent`,
  `src/server/index.ts`. Everything else receives config as arguments.
- `src/agent` imports nothing from the product code.

If a change needs to cross a boundary, it is a design decision: say so and
propose an ADR rather than editing the rule in the test.

## Conventions

- Named exports; JSDoc on exported symbols; explicit return types on exported
  functions.
- Each file opens with a header comment saying what it owns and which ADR or
  issue it comes from. `#N` and "wayfinder #N" are GitHub issues in this repo.
- TypeScript is strict with `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`; use `.ts` extensions in relative imports.
- Use the glossary's terms in code, tests, issues and PRs (VideoRecord, not
  "video row"; Ingest, not "sync").
- No new dependencies without a stated reason.

<!-- agent-rules:end -->

The block between the `agent-rules` markers is also the repair agent's rule
set (`src/agent/rules.ts`): keep it self-contained.

## Danger zones

- `migrations/`: add a new numbered file; never edit one that already exists
  (it is already applied in production).
- `pnpm ingest --remote` and `wrangler d1 ... --remote` write to the
  production D1. Do not run them unless explicitly asked.
- `.github/workflows/`, `wrangler.jsonc`: these control deploys and secrets.
  Change them only when the task is about them.
- `.env` holds real credentials: never print, commit or copy it.

## Done means

1. `pnpm check` passes.
2. Behavior changes come with a test through a public seam.
3. Any decision that contradicts an ADR is surfaced explicitly (see
   `docs/agents/domain.md`).

## Agent skills

Skills are vendored in `.claude/skills/` (MIT, from `mattpocock/skills` at the
commit pinned in `.claude/skills/skills.json`), so every agent sees the same
set without an install step. To add, drop or update one, edit `skills.json`
and run `pnpm skills:sync`; never hand-edit a vendored skill.

### Issue tracker

Issues and specs live as GitHub issues (managed via `gh`, or the GitHub MCP tools where `gh` is unavailable). See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage labels are used as-is. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: `GLOSSARY.md` at the repo root and `docs/adr/` for ADRs. See `docs/agents/domain.md`.
