/**
 * Cloudflare Worker entry point (`src/worker.ts`).
 *
 * Serves the same Hono app as the Node server (`../server/app.ts`) with DB
 * access routed through the D1 binding instead of better-sqlite3. `env` only
 * exists per request, so the app is built lazily on the first request and the
 * promise is cached for the isolate's lifetime.
 *
 * Wrapped in `Sentry.withSentry` so unhandled route errors are captured with
 * request context and grouped by Sentry into issues. An issue's `created`
 * webhook is what wakes the repair agent (see `server/api/agent-hook.ts`);
 * without a DSN the SDK is a no-op and the Worker behaves exactly as before.
 *
 * Wrangler bundles this module using `wrangler.jsonc`. Nothing in its import
 * graph may pull a Node builtin (see `./server/app.ts`).
 */
import * as Sentry from '@sentry/cloudflare';
import type { Hono } from 'hono';
import { createD1Executor, type D1Binding } from './db/d1.ts';
import { createApp } from './server/app.ts';
import { appConfigFromEnv, type AppEnv } from './server/config.ts';

/** Bindings available to the Worker (see `wrangler.jsonc`). */
export interface Env extends AppEnv {
  /** D1 database bound as `ytb_index`. */
  ytb_index: D1Binding;
  /** Sentry DSN (plain var — a DSN is a public write key). */
  SENTRY_DSN?: string;
}

// Built lazily: `env` is only available inside `fetch()`.
let appPromise: Promise<Hono> | undefined;

function getApp(env: Env): Promise<Hono> {
  appPromise ??= createApp({
    db: createD1Executor(env.ytb_index),
    ...appConfigFromEnv(env),
  });
  return appPromise;
}

export default Sentry.withSentry(
  (env: Env) =>
    env.SENTRY_DSN === undefined || env.SENTRY_DSN === ''
      ? undefined
      : {
          dsn: env.SENTRY_DSN,
          environment: 'production',
          // Errors only: no tracing means no extra CPU or event quota.
          tracesSampleRate: 0,
          // `sendDefaultPii` is not settable here: @sentry/cloudflare forbids it
          // in CloudflareOptions and keeps its own (off) default. Adding it
          // fails the build with "not assignable to type never".
        },
  {
    fetch(request: Request, env: Env): Promise<Response> {
      return getApp(env).then((app) => app.fetch(request, env));
    },
  },
);
