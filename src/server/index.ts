/**
 * Node HTTP entry point for ytb-index (`server/index`).
 *
 * The Hono app factory itself lives in `./app.ts` (the Worker import graph,
 * free of Node builtins). This module is Node-only: it opens the catalog with
 * the better-sqlite3 executor and serves the app with `@hono/node-server`.
 * Running it directly (`pnpm dev` / `pnpm start`) starts the server and
 * honours `--port` / `DB_PATH`.
 *
 * The server reads the catalog only; it never touches `src/yt` or the YouTube
 * API key (spec §6 / #11).
 */
import { serve } from '@hono/node-server';
import { pathToFileURL } from 'node:url';
import { openCatalog } from '../db/sqlite.ts';
import { createApp } from './app.ts';

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
  const app = await createApp({ db: await openCatalog(dbPath) });
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
