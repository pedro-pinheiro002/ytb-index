# Deploy the read server on Cloudflare Workers + D1

v1 serves the Catalog from a Node process backed by better-sqlite3 — a native, filesystem-bound, synchronous module that cannot run on Workers. The owner wants the site reachable 24/7 at personal scale, free; we chose to rewrite the read path as a Hono Worker over D1 on a free workers.dev subdomain, accepting a bounded async-DB rewrite as the price.

## Status

accepted

## Considered Options

- **Self-host behind Cloudflare Tunnel** — app runs unchanged, free. Rejected: availability tied to the workstation; owner wants always-up.
- **Always-on VM (Oracle Always Free, Fly)** — app runs unchanged incl. better-sqlite3. Rejected: VM babysitting (patching, uptime, signup luck); Cloudflare Containers went GA (Apr 2026) but are Workers Paid-only.
- **Pages** — rejected: maintenance mode; Cloudflare points new projects at Workers.
- **Workers + D1 (chosen)** — bounded rewrite: async executor for the DB layer, schema as D1 migrations, bindings instead of dotenv. Free-tier math at personal scale is comfortable: 100k dynamic requests/day (10 ms CPU each — read-only SSR pages fit), D1 5M reads/100k writes/day, 5 GB storage.

## Consequences

- DB access goes behind one async executor interface with two implementations — D1 (production binding) and better-sqlite3 (local dev, tests, offline ingest) — with all SQL written once as portable strings. The dual-engine setup is deliberate: it keeps the fast local test suite; don't "fix" it.
- Runtime `schema.sql` `readFileSync` disappears; schema ships as D1 migrations applied with `wrangler d1 migrations apply`.
- `@hono/node-server` drops out of the deployed artifact; `wrangler dev` becomes the local server; routes/SSR stay unchanged.
- The TTL view (`datetime('now')`-based, ADR-0001) is plain SQLite and carries over to D1 unchanged.
- A custom domain later is config-only (workers.dev → owned domain); the lock-in is the rewrite itself.
