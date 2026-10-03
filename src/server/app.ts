/**
 * Hono app factory shared by the Node server and the Cloudflare Worker
 * (`server/app`).
 *
 * This module is the Worker's import graph, so it must stay free of Node
 * builtins, `better-sqlite3`, `@hono/node-server`, and `dotenv`: the executor
 * is always injected. Opening a local catalog is the Node entry's job (see
 * `./index.ts`), and binding D1 is the Worker entry's job (see `../worker.ts`).
 *
 * The app is async only to keep one factory shape across runtimes; the Worker
 * caches the returned promise per isolate.
 */
import { Hono } from 'hono';
import type { Executor } from '../db/executor.ts';
import { catalogRoute } from './routes/catalog.ts';
import { videoRoute } from './routes/video.ts';

/** Options for {@link createApp}. */
export interface CreateAppOptions {
  /** Live executor the routes read through. Required: app.ts never opens a DB. */
  db: Executor;
}

/**
 * Build a fresh Hono app bound to one `Executor`.
 *
 * Passing a pre-opened executor lets the Node server, the Worker, and
 * integration tests share the exact same routes over different drivers.
 */
export async function createApp({ db }: CreateAppOptions): Promise<Hono> {
  const app = new Hono();
  catalogRoute(app, db);
  videoRoute(app, db);
  return app;
}
