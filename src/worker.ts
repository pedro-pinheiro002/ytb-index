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

/** Bindings available to the Worker (see `wrangler.jsonc`). */
export interface Env {
  /** D1 database bound as `ytb_index`. */
  ytb_index: D1Binding;
  /** Operator bearer token for `POST /api/ingest` (secret). */
  OPERATOR_TOKEN?: string;
  /** Fine-grained GitHub PAT for `repository_dispatch` (secret). */
  GH_DISPATCH_PAT?: string;
  /** GitHub owner for `repository_dispatch` (plain var). */
  GH_OWNER?: string;
  /** GitHub repository name for `repository_dispatch` (plain var). */
  GH_REPO?: string;
}

// Built lazily: `env` is only available inside `fetch()`.
let appPromise: Promise<Hono> | undefined;

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    appPromise ??= createApp({
      db: createD1Executor(env.ytb_index),
      ingest: {
        operatorToken: env.OPERATOR_TOKEN,
        dispatchPat: env.GH_DISPATCH_PAT,
        ghOwner: env.GH_OWNER,
        ghRepo: env.GH_REPO,
      },
    });
    return appPromise.then((app) => app.fetch(request, env));
  },
};
