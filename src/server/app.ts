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
import { agentHookRoute, type AgentHookConfig } from './api/agent-hook.ts';
import { ingestApiRoute, type IngestApiConfig } from './api/ingest.ts';
import { catalogRoute } from './routes/catalog.ts';
import { videoRoute } from './routes/video.ts';

/** Options for {@link createApp}. */
export interface CreateAppOptions {
  /** Live executor the routes read through. Required: app.ts never opens a DB. */
  db: Executor;
  /**
   * Operator ingest API config (ADR-0005). Omitted in read-only contexts:
   * `POST /api/ingest` then fails closed (401) while the status read stays up.
   */
  ingest?: IngestApiConfig | undefined;
  /**
   * Repair-agent webhook config. Omitted in read-only contexts (tests); with
   * it but without `SENTRY_HOOK_SECRET`, `POST /api/agent-hook` fails closed (503).
   */
  agentHook?: AgentHookConfig | undefined;
}

/**
 * Build a fresh Hono app bound to one `Executor`.
 *
 * Passing a pre-opened executor lets the Node server, the Worker, and
 * integration tests share the exact same routes over different drivers.
 */
export async function createApp({ db, ingest, agentHook }: CreateAppOptions): Promise<Hono> {
  const app = new Hono();
  catalogRoute(app, db);
  videoRoute(app, db);
  ingestApiRoute(app, db, ingest ?? {});
  agentHookRoute(app, agentHook ?? {});
  return app;
}
