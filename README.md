# ytb-index

A TypeScript + Hono service that turns one YouTube channel into a browseable, timestamped-comment catalog. Point it at a channel, ingest uploads + top-level comments once, and serve a static HTML index where every `1:23` / `5:32` you find in the comments links out to the YouTube player at that offset.

One channel per run · one-shot fetch · server-rendered HTML · SQLite in a single file · no client-side framework.

See [`docs/spec/v1.md`](docs/spec/v1.md) for the full v1 specification and [`GLOSSARY.md`](GLOSSARY.md) for canonical vocabulary.

## What you get

- **Ingest pipeline** (`pnpm ingest <channel>`) — pulls a channel's uploads playlist, enriches videos in batches of 50, pages every video's top-level comments, and detects timestamps in the comment text.
- **Static web catalog** (`pnpm dev` / `pnpm start`) — two SSR routes (`/`, `/v/:videoId`) over the SQLite file. The server never calls the YouTube API.
- **Click-to-jump anchors** — every `TimeAnchor` (matched `h:mm:ss` and sentinel-anchored `mm:ss`) renders as `https://www.youtube.com/watch?v={id}&t={s}s` in a new tab.
- **TTL redaction** — comment bodies past 30 days from `fetched_at` are replaced at read time with `[Comment text expired — refresh to recover]`; anchor links survive. See [ADR-0001](docs/adr/0001-ttl-policy.md).

## Prerequisites

- **Node 24 LTS** — pinned via `engines.node` and `.nvmrc`.
- **pnpm 9.12+** — pinned via `packageManager`.
- **YouTube Data API v3 key** — read-only public data, no OAuth. Get one from the [Google Cloud Console](https://console.cloud.google.com/) with the YouTube Data API v3 enabled. Default quota is 10 000 units/day, reset at midnight Pacific.

## Install

```bash
pnpm install
cp .env.example .env   # then set YOUTUBE_API_KEY=AIza...
```

The API key is **only required for `pnpm ingest`**. The server boots without it.

## Usage

### Ingest a channel

```bash
pnpm ingest @mkbhd                  # by handle
pnpm ingest UCBks01f-a....          # by channel ID
pnpm ingest https://www.youtube.com/@mkbhd
pnpm ingest --verbose @mkbhd        # extra logging
```

Accepted inputs (`src/yt/parse-channel.ts`): `@handle`, bare `handle`, `UC…` channel ID, or any canonical YouTube URL pointing at either.

Locally, the run commits in a single transaction. Anything that fails mid-run leaves the previous catalog untouched.

### Remote ingest (D1)

`--remote` writes the whole run to the production D1 database over the D1 HTTP API instead of `catalog.sqlite` (ADR-0003). Fill the credentials in `.env` — see [`.env.example`](.env.example):

- `CLOUDFLARE_API_TOKEN` — needs **D1 Write** plus Workers Scripts Write: start from the "Edit Cloudflare Workers" template and **add D1 Write** (the template alone does not include D1). Scope the token to your account.
- `CLOUDFLARE_ACCOUNT_ID` — your Cloudflare account id.
- `D1_DATABASE_ID` — the `ytb-index` database id.

```bash
pnpm ingest @mkbhd --remote
```

Remote writes are chunked (~20 statements per HTTP call) and best-effort, not transactional: the D1 HTTP API does not document atomicity for its batch endpoint. Upserts are idempotent, so a failed or partial write is repaired by re-running the same command. Exit codes match local ingest (`1` on a failed write).

### Serve the catalog

```bash
pnpm dev      # tsx watch on :3000
pnpm start    # production build, serves dist/server/index.js
```

Defaults to `./catalog.sqlite` (override with `DB_PATH=...`) and port `3000` (override with `--port 4000` or env).

Then open:

- `http://localhost:3000/` — catalog index (one row per video: thumbnail, title, published date, `N comments / K timestamped`).
- `http://localhost:3000/v/<videoId>` — video detail page; all top-level comments newest-first, with timestamped comments accented and a `Timestamps:` footer listing every detected offset as a clickable link.

### Run the Worker locally

The production read path is a Cloudflare Worker over D1 (ADR-0002). Wrangler serves the same routes on `:8787`:

```bash
pnpm exec wrangler d1 migrations apply ytb-index --local   # apply migrations/ to local D1
pnpm dev:worker                                            # http://localhost:8787
```

The local Worker D1 is miniflare's storage under `.wrangler/` — it is **separate from `catalog.sqlite`**, the file the Node server and `pnpm ingest` use. That separation is intended (ADR-0002's dual-engine setup): the Node path stays the fast local dev/test/ingest loop, while the Worker path mirrors production D1.

### Trigger an ingest (Operator)

`POST /api/ingest` records an IngestRequest and fires a GitHub `repository_dispatch`; `GET /api/ingest/status` is public (204 until the first request). Reads stay public, writes require the operator token. Set the two Worker secrets once (never committed):

```bash
pnpm exec wrangler secret put OPERATOR_TOKEN    # Bearer token for POST /api/ingest
pnpm exec wrangler secret put GH_DISPATCH_PAT   # fine-grained PAT, Contents: write
```

`GH_OWNER` / `GH_REPO` are plain `vars` in `wrangler.jsonc` (public info). Locally, `pnpm dev` reads the same names from `.env` — see [`.env.example`](.env.example).

### Pay with your own key (OperatorKey)

The operator panel can send your own YouTube Data API key (the OperatorKey) with a trigger, so the Ingest spends your Google Cloud project's quota instead of the repo's `YOUTUBE_API_KEY` ([ADR-0007](docs/adr/0007-operator-supplies-own-api-key.md)). "Check key" calls `POST /api/key/check` (operator token required), which makes one 1-unit `channels.list` call and reports `ok`, `invalid`, `quotaExceeded`, `apiNotEnabled`, `restricted` or `unavailable`. On trigger, the Worker checks the key again, seals it with RSA-OAEP-256 and dispatches only the ciphertext; the Actions runner unseals and masks it ([ADR-0008](docs/adr/0008-sealed-operator-key-to-actions-runner.md)). The key is never stored in D1 or printed.

Generate the sealing key pair once (rotate by repeating both steps):

```bash
pnpm exec tsx scripts/gen-seal-keypair.ts
# 1. public JWK  -> wrangler.jsonc vars.INGEST_SEAL_PUBLIC_KEY, then deploy
# 2. private JWK -> gh secret set INGEST_SEAL_PRIVATE_KEY
```

While `INGEST_SEAL_PUBLIC_KEY` is empty, triggers that carry a key answer `503` (fail closed); triggers without one keep using `YOUTUBE_API_KEY`.

## Configuration

| Env var | Required by | Notes |
| --- | --- | --- |
| `YOUTUBE_API_KEY` | `pnpm ingest` | Validated locally before any API call: presence + `^AIza[A-Za-z0-9_-]{30,50}$`. |
| `DB_PATH` | server | Path to SQLite file. Defaults to `./catalog.sqlite`. |
| `OPERATOR_TOKEN` | `POST /api/ingest` | Bearer token for the operator API. Worker secret in production; `.env` for `pnpm dev`. |
| `GH_DISPATCH_PAT` | `POST /api/ingest` | Fine-grained PAT (Contents: write) for `repository_dispatch`. Worker secret; `.env` for `pnpm dev`. |
| `GH_OWNER` / `GH_REPO` | `POST /api/ingest` | GitHub coordinates for the dispatch. Wrangler `vars` (public info); `.env` for `pnpm dev`. |
| `INGEST_SEAL_PUBLIC_KEY` | `POST /api/ingest` with a key | Public RSA-OAEP-256 JWK the OperatorKey is sealed under. Wrangler `var`; empty disables OperatorKey triggers (503). |
| `INGEST_SEALED_KEY` / `INGEST_SEAL_PRIVATE_KEY` | `pnpm ingest` | Sealed OperatorKey (`v1.…`) and the private JWK that opens it; when set, it replaces `YOUTUBE_API_KEY`. Set by the ingest workflow. |

Validation happens at step 1 of the ingest pipeline, before CLI parsing, before the DB is opened. A bad key never burns quota. See [spec §8](docs/spec/v1.md#8-api-key-management).

## Project layout

```
src/
├── worker.ts # Cloudflare Worker entry (server app over the D1 binding)
├── server/   # Hono app, SSR routes (/, /v/:videoId), operator + agent-hook APIs
├── yt/       # YouTube Data API v3 client + TimeAnchor detection + API-key validation
├── db/       # Executor interface, portable queries, SQLite / D1 / D1 HTTP drivers
├── ingest/   # Ingest pipeline steps: YouTube responses → Catalog rows
├── cli/      # Ingest entrypoint (src/cli/ingest.ts): env, quota, writes, exit codes
├── agent/    # Sentry-triggered repair agent (ADR-0006), isolated from the rest
└── shared/   # Cross-cutting types (Channel, VideoRecord, CommentRecord, TimeAnchor)
```

Dependency arrows: `worker → server → db → shared`, `cli → ingest → yt → shared`, `cli → db → shared`. `shared/` is the leaf. These boundaries are enforced by [`src/architecture.test.ts`](src/architecture.test.ts).

The authoritative artifact for the SQLite schema is [`migrations/0001_init.sql`](migrations/0001_init.sql).

## Scripts

| Script | What it does |
| --- | --- |
| `pnpm dev` | Watch + serve the SSR app on `:3000`. |
| `pnpm dev:worker` | Serve the Worker locally with `wrangler dev` on `:8787`. |
| `pnpm build` | Type-check and emit to `dist/`. |
| `pnpm start` | Run the built server (`node dist/server/index.js`). |
| `pnpm deploy` | Deploy the Worker with `wrangler deploy`. |
| `pnpm ingest <channel>` | Run the one-shot ingest pipeline. |
| `pnpm typecheck` | `tsc --noEmit` against the project config. |
| `pnpm test` | Run `node --test` suites under `src/**/*.test.ts`. |
| `pnpm format` / `pnpm format:check` | Prettier write / check. |
| `pnpm build:worker` | Bundle the Worker without deploying (`wrangler deploy --dry-run`). |
| `pnpm check` | typecheck + test + format:check + build:worker — the CI gate. |

## Development

```bash
pnpm install
pnpm check
```

The repo uses Prettier 3 and no ESLint. `pnpm check` is the only CI gate; module boundaries are tests (`src/architecture.test.ts`), not lint rules.

Ingest seams for tests:

- `transport` — `(url, init?) => Promise<Response>`. Default `globalThis.fetch`.
- `quota` — a `QuotaCounter` (default 9500-unit budget; spec warns at 8000, aborts at 9500).
- `now` — clock override for deterministic `fetchedAt`.

## Limitations (v1)

These are deliberate v1 cuts — see [spec §3](docs/spec/v1.md#3-scope) and the [Out of scope](https://github.com/pedro-pinheiro002/ytb-index/issues/1) tracker ticket:

- **One channel per run.** Re-running overwrites the SQLite file.
- **Top-level comments only.** Replies are skipped at the API level.
- **No pagination.** All videos render on one page.
- **No search / filter / sort** on the catalog.
- **No auth, no OAuth.** Personal-use single-operator app.
- **YouTube embeds and in-page seek are not used.** Every jump opens YouTube in a new tab.

## Tech stack

| Concern | Choice |
| --- | --- |
| Runtime | Node 24 LTS |
| Package manager | pnpm 9.12 |
| HTTP framework | Hono 4 + `@hono/node-server` |
| SQLite driver | `better-sqlite3 ^11.7` |
| Env loader | `dotenv ^16.4` |
| TS dev / prod | `tsx watch` / `tsc` → `node dist/...` |
| Formatting | Prettier 3 |

## License

Private project — no license declared.