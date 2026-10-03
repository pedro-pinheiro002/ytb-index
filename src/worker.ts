/**
 * Cloudflare Worker entry point (`src/worker.ts`).
 *
 * Serves the same Hono app as the Node server (`../server/app.ts`) with DB
 * access routed through the D1 binding instead of better-sqlite3. `env` only
 * exists per request, so the app is built lazily on the first request and the
 * promise is cached for the isolate's lifetime.
 *
 * Wrangler bundles this module using `wrangler.jsonc`. Nothing in its import
 * graph may pull a Node builtin (see `./server/app.ts`).
 */
import type { Hono } from 'hono';
import { createD1Executor, type D1Binding } from './db/d1.ts';
import { createApp } from './server/app.ts';

/** Bindings available to the Worker (see `wrangler.jsonc` `d1_databases`). */
export interface Env {
  /** D1 database bound as `ytb_index`. */
  ytb_index: D1Binding;
}

// Built lazily: `env` is only available inside `fetch()`.
let appPromise: Promise<Hono> | undefined;

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    appPromise ??= createApp({ db: createD1Executor(env.ytb_index) });
    return appPromise.then((app) => app.fetch(request, env));
  },
};
