/**
 * Hono app factory and HTTP entry point for ytb-index (`server/index`).
 *
 * `createApp({ dbPath })` opens the catalog once (better-sqlite3 `Executor`,
 * migrations applied) and mounts the two SSR routes (`/`, `/v/:videoId`).
 * `start({ dbPath, port })` serves that app with `@hono/node-server`. Running
 * this module directly (`pnpm dev` / `pnpm start`) starts the server and
 * honours `--port` / `DB_PATH`.
 *
 * The server reads the catalog only; it never touches `src/yt` or the YouTube
 * API key (spec §6 / #11).
 */
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { pathToFileURL } from 'node:url';
import type { Executor } from '../db/executor.ts';
import { openCatalog } from '../db/sqlite.ts';
import { catalogRoute } from './routes/catalog.ts';
import { videoRoute } from './routes/video.ts';

/** Options for {@link createApp}. */
export interface CreateAppOptions {
  /** SQLite path or `:memory:`. Defaults to `./catalog.sqlite`. */
  dbPath?: string;
  /** Pre-opened executor (used by tests). When given, `dbPath` is ignored. */
  db?: Executor;
}

/**
 * Build a fresh Hono app bound to one `Executor`.
 *
 * Passing a pre-opened `db` lets integration tests seed an in-memory database
 * and then exercise the real routes against the same executor. Otherwise the
 * catalog at `dbPath` is opened and migrated first.
 */
export async function createApp({
  dbPath = './catalog.sqlite',
  db,
}: CreateAppOptions = {}): Promise<Hono> {
  const executor = db ?? (await openCatalog(dbPath));
  const app = new Hono();
  catalogRoute(app, executor);
  videoRoute(app, executor);
  return app;
}

/** Options for {@link start}. */
export interface StartOptions {
  /** SQLite path or `:memory:`. Defaults to `./catalog.sqlite`. */
  dbPath?: string;
  /** TCP port to listen on. Defaults to `3000`. */
  port?: number;
}

/** Serve the app on `port` using `@hono/node-server`. */
export async function start({
  dbPath = './catalog.sqlite',
  port = 3000,
}: StartOptions = {}): Promise<void> {
  const app = await createApp({ dbPath });
  serve({ fetch: app.fetch, port });
}

/** Parse `--port 3000` or `--port=3000` from argv, or `undefined`. */
function parsePort(argv: string[]): number | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--port') {
      const value = argv[index + 1];
      if (value !== undefined) {
        return Number(value);
      }
    } else if (arg?.startsWith('--port=')) {
      return Number(arg.slice('--port='.length));
    }
  }
  return undefined;
}

// CLI shim: only run when this module is the process entry point.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = parsePort(process.argv.slice(2));
  const dbPath = process.env.DB_PATH ?? './catalog.sqlite';
  void start(port === undefined ? { dbPath } : { dbPath, port });
}
