# ytb-index

A TypeScript + Hono service that turns one YouTube channel into a browseable, timestamped-comment catalog. Point it at a channel, ingest uploads + top-level comments once, and serve a static HTML index where every `1:23` / `5:32` you find in the comments links out to the YouTube player at that offset.

One channel per run · one-shot fetch · server-rendered HTML · SQLite in a single file · no client-side framework.

See [`docs/spec/v1.md`](docs/spec/v1.md) for the v1 specification, [`docs/spec/v2.md`](docs/spec/v2.md) for what v2 adds, and [`GLOSSARY.md`](GLOSSARY.md) for canonical vocabulary.

## What you get

- **Ingest pipeline** (`pnpm ingest <channel>`) — pulls a channel's uploads playlist, enriches videos in batches of 50, pages the channel's comments in one channel-wide stream (1 quota unit per 100 threads), and detects timestamps in the comment text.
- **Static web catalog** (`pnpm dev` / `pnpm start`) — two SSR routes (`/`, `/v/:videoId`) over the SQLite file. The server never calls the YouTube API.
- **Click-to-jump anchors** — every `TimeAnchor` (matched `h:mm:ss` and sentinel-anchored `mm:ss`) renders as `https://www.youtube.com/watch?v={id}&t={s}s` in a new tab.
- **TTL redaction** — comment bodies past 30 days from `fetched_at` are replaced at read time with `[Comment text expired — refresh to recover]`; anchor links survive. See [ADR-0001](docs/adr/0001-ttl-policy.md).

## What's new in v2

- **Search** — `/search` finds comments, Replies, live chat and videos in the Catalog by terms, date range, author (display name or `UC…` id) and record kind, with sorting and pagination. Every SearchHit links to the video page in the app and to YouTube at the right second. Accents and case are folded, so `joao` finds "João" ([ADR-0010](docs/adr/0010-catalog-search-normalized-like-not-fts5.md)).
- **Broadcasts** — live streams and premieres are stored as Broadcasts, with their real start and end times and a badge on the video page. Upcoming Broadcasts are skipped until they start.
- **Replies** — Replies are ingested with their top-level comment, get TimeAnchor detection, and are shown nested under it. Each comment's `authorChannelId` is stored too.
- **Live chat** — opt-in capture of the chat of any Broadcast that is on air during the Ingest, shown in a "Live chat" panel on its video page ([ADR-0009](docs/adr/0009-live-chat-official-api-active-broadcasts-only.md)).
- **OperatorKey** — the Operator can pay for an Ingest with their own YouTube Data API key, checked in the web app and sealed to the runner ([ADR-0007](docs/adr/0007-operator-supplies-own-api-key.md), [ADR-0008](docs/adr/0008-sealed-operator-key-to-actions-runner.md)).

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
pnpm ingest @mkbhd --live-chat      # also capture on-air Broadcasts' chat (below)
```

Accepted inputs (`src/yt/parse-channel.ts`): `@handle`, bare `handle`, `UC…` channel ID, or any canonical YouTube URL pointing at either.

Locally, the run commits in a single transaction. Anything that fails mid-run leaves the previous catalog untouched.

The summary line counts top-level comments (`comments=`) and Replies (`replies=`) apart; `skipped=` counts upcoming Broadcasts plus videos whose comments are disabled or not found, and `chat=` the LiveChatMessages written.

### Capture live chat

With `--live-chat` (or `INGEST_CAPTURE_LIVE_CHAT=true`, which the ingest workflow sets from the operator panel's "Capture live chat" checkbox), the Ingest also records the chat of every Broadcast that is **on air while it runs** ([ADR-0009](docs/adr/0009-live-chat-official-api-active-broadcasts-only.md)). So trigger it while the stream is live. The chat of a Broadcast that has already ended cannot be replayed: only the official API is used, and it serves chat only while the Broadcast is on air.

```bash
pnpm ingest @mkbhd --live-chat                          # default 3000-unit chat budget
pnpm ingest @mkbhd --live-chat --live-chat-budget 1000  # spend at most 1000 units on chat
```

After the main write, the CLI polls the chat at the interval YouTube asks for and writes each poll at once, so a run cut short keeps what it captured. Each poll costs about 5 quota units (a 2 h stream at a 5 s interval would be ~7 200 units, hence the 3 000-unit default). Capture stops at the first of: the Broadcast going offline, the chat ending, the chat budget, or a 5 h wall-clock cap (under the 6 h Actions job limit). Only text messages and Super Chat comments are stored; each one's offset from the Broadcast's real start links to that second on YouTube.

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
- `http://localhost:3000/v/<videoId>` — video detail page; comments newest-first with their Replies nested under them, timestamped comments accented with a `Timestamps:` footer listing every detected offset as a clickable link. A Broadcast also gets its badge, real start time and duration, and a "Live chat" panel.
- `http://localhost:3000/search` — search the Catalog (below).

### Search the Catalog

`/search` is a plain GET form, so every search is a bookmarkable URL. It reads the Catalog only, never YouTube. The full contract is in [spec v2, "SearchQuery contract"](docs/spec/v2.md#searchquery-contract-get-search); in short:

| Param | Meaning |
| --- | --- |
| `q` | Terms, all must match; accents, case and punctuation are ignored. Up to 8 terms of 2+ characters. |
| `kind` | Repeatable: `comment`, `reply`, `chat`, `video`. Default: `comment`, `reply`, `chat`. |
| `channel` | A `UC…` id; default every Channel. |
| `from`, `to` | `YYYY-MM-DD`, inclusive, on when the comment or message was written (UTC). |
| `videoFrom`, `videoTo` | `YYYY-MM-DD`, inclusive, on the video's publish date. |
| `author` | A `UC…` id matches that channel exactly; anything else matches part of the display name (`jose` finds "José"). |
| `timestamped` | `1`: only comments with TimeAnchors, plus all live chat. |
| `sort` | `newest` (default), `oldest`, `likes`. |
| `page` | 25 hits per page, up to page 40. |

Each SearchHit links to `/v/<videoId>#c-<commentId>` (or `#m-<messageId>` for chat) and to YouTube: at the first TimeAnchor (`&t=83s`), at a chat message's offset, or, for a comment without anchors, with `&lc=<commentId>`. Invalid params show an inline message with HTTP 400. Expired comments and chat never match.

**LiveSearch (Operator).** With `q` and a `channel` set, an Operator whose browser holds an OperatorKey also gets a "Search live" button. It asks YouTube directly from the browser (`commentThreads.list` with `allThreadsRelatedToChannelId` + `searchTerms`), 1–3 units of the OperatorKey's quota per search, and finds comments the Catalog does not have yet. The Worker never sees the key or the results, and nothing is stored. YouTube matches whole words and does not fold accents ([ADR-0011](docs/adr/0011-live-search-from-the-operators-browser.md)).

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

The operator panel can send your own YouTube Data API key (the OperatorKey) with a trigger, so the Ingest spends your Google Cloud project's quota instead of the repo's `YOUTUBE_API_KEY` ([ADR-0007](docs/adr/0007-operator-supplies-own-api-key.md)). The flow:

1. **Paste and check.** "Check key" calls `POST /api/key/check` (operator token required, so nobody can use the site to test keys). After a local shape check it makes one 1-unit `channels.list` call and shows a verdict with its own message:

   | Verdict | What it tells you |
   | --- | --- |
   | `ok` | The key works; the panel remembers it in this browser until you forget it. |
   | `invalid` | Google rejected the key: copy it again, whole. |
   | `quotaExceeded` | The key's quota is used up for today; it resets at midnight Pacific Time. |
   | `apiNotEnabled` | Enable the YouTube Data API v3 in the key's Google Cloud project. |
   | `restricted` | HTTP referrer, IP or API restrictions block server use: relax them or use another key. |
   | `unavailable` | YouTube could not be reached: try again. |

2. **Trigger.** The Worker checks the key again (a failed check answers `422` and creates no IngestRequest), seals it with RSA-OAEP-256 under `INGEST_SEAL_PUBLIC_KEY` and dispatches only the ciphertext. The Actions runner unseals it with `INGEST_SEAL_PRIVATE_KEY` and masks it in the logs ([ADR-0008](docs/adr/0008-sealed-operator-key-to-actions-runner.md)). The key is never stored in D1, logged, or dispatched in clear.
3. **Fallback.** A trigger without a key uses the repo secret `YOUTUBE_API_KEY`, as in v1. Locally, `pnpm ingest` uses `YOUTUBE_API_KEY` from `.env` unless `INGEST_SEALED_KEY` is set.

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
| `INGEST_SEALED_KEY` | `pnpm ingest` | Sealed OperatorKey (`v1.…`); when set, it replaces `YOUTUBE_API_KEY`. Set by the ingest workflow from the dispatch payload. |
| `INGEST_SEAL_PRIVATE_KEY` | `pnpm ingest` with a sealed key | Private RSA-OAEP-256 JWK that opens `INGEST_SEALED_KEY`. Repo secret in Actions; required whenever `INGEST_SEALED_KEY` is set. |
| `INGEST_CAPTURE_LIVE_CHAT` | `pnpm ingest` | `true` turns on live-chat capture, like `--live-chat`. Set by the ingest workflow from the operator panel's checkbox. |

Validation happens at step 1 of the ingest pipeline, before CLI parsing, before the DB is opened. A bad key never burns quota. See [spec §8](docs/spec/v1.md#8-api-key-management).

## Project layout

```
src/
├── worker.ts # Cloudflare Worker entry (server app over the D1 binding)
├── server/   # Hono app, SSR routes (/, /v/:videoId, /search), operator + agent-hook APIs
├── yt/       # YouTube Data API v3 client + TimeAnchor detection + API-key validation
├── db/       # Executor, Catalog reads + search, Ingest writes, SQLite / D1 / D1 HTTP drivers
├── ingest/   # Ingest stages (incl. live chat): YouTube responses → Catalog rows
├── cli/      # Ingest entrypoint (src/cli/ingest.ts): env, quota, writes, exit codes
├── agent/    # Sentry-triggered repair agent (ADR-0006), isolated from the rest
└── shared/   # Cross-cutting types (Channel, VideoRecord, CommentRecord, TimeAnchor)
```

Dependency arrows: `worker → server → db → shared`, `cli → ingest → yt → shared`, `cli → db → shared`. `shared/` is the leaf. These boundaries are enforced by [`src/architecture.test.ts`](src/architecture.test.ts).

The authoritative artifact for the SQLite schema is [`migrations/`](migrations/), applied in order (`0003_v2_catalog.sql` adds the v2 columns, `live_chat_messages` and the search indexes).

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
- `now` — clock override for deterministic `fetchedAt` (and the live-chat wall-clock cap).
- `sleep` — the wait between live-chat polls; tests pass one that advances `now`.

[`src/e2e.test.ts`](src/e2e.test.ts) runs a fixture Ingest with `--live-chat` into SQLite and then searches it through the app, end to end.

## Limitations

These are deliberate cuts — see [spec v1 §3](docs/spec/v1.md#3-scope), [spec v2 "Out of Scope"](docs/spec/v2.md#out-of-scope) and the [Out of scope](https://github.com/pedro-pinheiro002/ytb-index/issues/1) tracker ticket:

- **One channel per run.** Re-running overwrites the SQLite file.
- **No pagination on the catalog index.** All videos render on one page (search results are paged).
- **Live chat only while on air.** No replay of ended Broadcasts, no unofficial endpoints; only text and Super Chat comments are kept.
- **Search is substring matching.** Terms are ANDed; no relevance ranking, stemming or phrase search (no FTS5).
- **No OAuth, one Operator.** The operator token gates writes; the OperatorKey is a plain API key.
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