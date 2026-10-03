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
cp .env.example .env   # if present; otherwise just create .env
echo 'YOUTUBE_API_KEY=AIza...' >> .env
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

The run commits in a single transaction. Anything that fails mid-run leaves the previous catalog untouched.

### Serve the catalog

```bash
pnpm dev      # tsx watch on :3000
pnpm start    # production build, serves dist/server/index.js
```

Defaults to `./catalog.sqlite` (override with `DB_PATH=...`) and port `3000` (override with `--port 4000` or env).

Then open:

- `http://localhost:3000/` — catalog index (one row per video: thumbnail, title, published date, `N comments / K timestamped`).
- `http://localhost:3000/v/<videoId>` — video detail page; all top-level comments newest-first, with timestamped comments accented and a `Timestamps:` footer listing every detected offset as a clickable link.

## Configuration

| Env var | Required by | Notes |
| --- | --- | --- |
| `YOUTUBE_API_KEY` | `pnpm ingest` | Validated locally before any API call: presence + `^AIza[A-Za-z0-9_-]{30,50}$`. |
| `DB_PATH` | server | Path to SQLite file. Defaults to `./catalog.sqlite`. |

Validation happens at step 1 of the ingest pipeline, before CLI parsing, before the DB is opened. A bad key never burns quota. See [spec §8](docs/spec/v1.md#8-api-key-management).

## Project layout

```
src/
├── server/   # Hono app, SSR routes (/, /v/:videoId)
├── yt/       # YouTube Data API v3 client + TimeAnchor detection + API-key validation
├── db/       # SQLite driver, schema, queries
├── cli/      # Ingest entrypoint (src/cli/ingest.ts)
└── shared/   # Cross-cutting types (Channel, VideoRecord, CommentRecord, TimeAnchor)
```

Dependency arrows: `server → db → shared`, `cli → yt → shared`, `cli → db → shared`. `shared/` is the leaf.

The authoritative artifact for the SQLite schema is [`docs/spec/v1/schema.sql`](docs/spec/v1/schema.sql).

## Scripts

| Script | What it does |
| --- | --- |
| `pnpm dev` | Watch + serve the SSR app on `:3000`. |
| `pnpm build` | Type-check and emit to `dist/`. |
| `pnpm start` | Run the built server (`node dist/server/index.js`). |
| `pnpm ingest <channel>` | Run the one-shot ingest pipeline. |
| `pnpm typecheck` | `tsc --noEmit` against the project config. |
| `pnpm test` | Run `node --test` suites under `src/**/*.test.ts`. |
| `pnpm format` / `pnpm format:check` | Prettier write / check. |

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm format:check
```

The repo uses Prettier 3 and no ESLint. Lint, typecheck, and tests are the only CI gates.

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