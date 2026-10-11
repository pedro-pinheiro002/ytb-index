/**
 * Operator ingest API (`server/api/ingest`), mounted by `createApp`.
 *
 * `POST /api/ingest` — token-gated write (ADR-0005):
 *   1. `Authorization: Bearer <OPERATOR_TOKEN>` (constant-time compare).
 *   2. Validate/normalize the channel input without importing `src/yt`
 *      (`./channel-input.ts`), so the server stays clear of the ingest
 *      pipeline (ADR-0002/0003).
 *   3. Enforce one active IngestRequest per `channel_key`
 *      (queued|running) -> `409 { requestId }` with the existing request's id.
 *   4. Insert a `queued` row and fire a GitHub `repository_dispatch`
 *      (`./github-dispatch.ts`) carrying `{ requestId, channel }`.
 *   5. Dispatch failure -> row marked `failed` (error: "dispatch failed"),
 *      response `502`; success -> `202 { requestId }`.
 *
 * `GET /api/ingest/status` — public read of the latest IngestRequest as
 * `{ requestId, channelId, status, videosWritten, commentsWritten, error,
 * updatedAt }`. When no request exists it answers **`204 No Content`** (no
 * body); callers treat 204 as "nothing yet".
 *
 * The module only uses runtime globals (fetch, TextEncoder, crypto.randomUUID)
 * plus portable SQL through the `Executor`, so it bundles for Workers.
 */
import type { Hono } from 'hono';
import type { Executor } from '../../db/executor.ts';
import { loadLatestIngestStatus } from '../data.ts';
import { normalizeChannelInput } from './channel-input.ts';
import { dispatchIngest, type DispatchTransport } from './github-dispatch.ts';

/** Configuration for the ingest API; all fields optional (fail closed). */
export interface IngestApiConfig {
  /** Shared operator token (`OPERATOR_TOKEN`, Worker secret). */
  operatorToken?: string | undefined;
  /** Fine-grained GitHub PAT (`GH_DISPATCH_PAT`, Worker secret). */
  dispatchPat?: string | undefined;
  /** GitHub owner (`GH_OWNER`, Worker var). */
  ghOwner?: string | undefined;
  /** GitHub repository name (`GH_REPO`, Worker var). */
  ghRepo?: string | undefined;
  /** Injectable dispatch transport; defaults to `globalThis.fetch`. */
  transport?: DispatchTransport | undefined;
  /** Injectable clock for deterministic tests. */
  now?: (() => Date) | undefined;
  /** Injectable id generator for deterministic tests. */
  uuid?: (() => string) | undefined;
}

const SELECT_ACTIVE_REQUEST_SQL = `
  SELECT id
  FROM ingest_requests
  WHERE channel_key = ? AND status IN ('queued', 'running')
  ORDER BY created_at DESC, rowid DESC
  LIMIT 1
`;

const INSERT_REQUEST_SQL = `
  INSERT INTO ingest_requests (
    id, channel_input, channel_key, channel_id, status,
    videos_written, comments_written, error, created_at, updated_at, finished_at
  )
  VALUES (?, ?, ?, NULL, 'queued', 0, 0, NULL, ?, ?, NULL)
`;

const MARK_REQUEST_FAILED_SQL = `
  UPDATE ingest_requests
  SET status = 'failed', error = ?, updated_at = ?, finished_at = ?
  WHERE id = ?
`;

/**
 * Constant-time string equality: every byte pair is folded into one
 * accumulator and the loop always runs over `max(a.length, b.length)`, so
 * neither content nor an early mismatch is observable through timing. Length
 * is not hidden, which is standard for bearer-token checks.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  const length = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;
  for (let index = 0; index < length; index += 1) {
    diff |= (aBytes[index] ?? 0) ^ (bBytes[index] ?? 0);
  }
  return diff === 0;
}

/**
 * True when `header` is `Bearer <expected>` and `expected` is configured.
 * A missing/empty `OPERATOR_TOKEN` rejects every request (fail closed).
 */
function isAuthorized(header: string | undefined, expected: string | undefined): boolean {
  if (expected === undefined || expected === '') {
    return false;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
  if (match === null) {
    return false;
  }
  return constantTimeEqual(match[1] ?? '', expected);
}

/**
 * Mount the ingest API on `app`. `db` is the executor owned by the app
 * factory; `config` carries the Worker bindings (or `.env` values locally).
 */
export function ingestApiRoute(app: Hono, db: Executor, config: IngestApiConfig = {}): void {
  const now = config.now ?? ((): Date => new Date());
  const uuid = config.uuid ?? ((): string => crypto.randomUUID());

  app.post('/api/ingest', async (c) => {
    if (!isAuthorized(c.req.header('authorization'), config.operatorToken)) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const channel = (body as { channel?: unknown } | null | undefined)?.channel;
    if (typeof channel !== 'string') {
      return c.json({ error: 'body must be {"channel": "<@handle | UC… id | YouTube URL>"}' }, 400);
    }
    const normalized = normalizeChannelInput(channel);
    if (!normalized.ok) {
      return c.json({ error: normalized.error }, 400);
    }

    const active = await db.get<{ id: string }>(SELECT_ACTIVE_REQUEST_SQL, [normalized.channelKey]);
    if (active !== undefined) {
      return c.json({ requestId: active.id }, 409);
    }

    const requestId = uuid();
    const createdAt = now().toISOString();
    try {
      await db.run(INSERT_REQUEST_SQL, [
        requestId,
        channel,
        normalized.channelKey,
        createdAt,
        createdAt,
      ]);
    } catch (error) {
      // The unique partial index (`idx_ingest_requests_active_channel`) caught
      // a concurrent trigger that passed the read above: report the winner.
      const raced = await db.get<{ id: string }>(SELECT_ACTIVE_REQUEST_SQL, [
        normalized.channelKey,
      ]);
      if (raced !== undefined) {
        return c.json({ requestId: raced.id }, 409);
      }
      throw error;
    }

    try {
      await dispatchIngest({
        owner: config.ghOwner ?? '',
        repo: config.ghRepo ?? '',
        pat: config.dispatchPat ?? '',
        requestId,
        channel,
        transport: config.transport,
      });
    } catch {
      const failedAt = now().toISOString();
      await db.run(MARK_REQUEST_FAILED_SQL, ['dispatch failed', failedAt, failedAt, requestId]);
      return c.json({ error: 'dispatch failed' }, 502);
    }

    return c.json({ requestId }, 202);
  });

  // Public: visitors and the operator both poll this; no token required.
  app.get('/api/ingest/status', async (c) => {
    const latest = await loadLatestIngestStatus(db);
    if (latest === null) {
      // Documented convention: 204 (no body) means "no IngestRequest yet".
      return c.body(null, 204);
    }
    return c.json({
      requestId: latest.id,
      channelId: latest.channelId,
      status: latest.status,
      videosWritten: latest.videosWritten,
      commentsWritten: latest.commentsWritten,
      error: latest.error,
      updatedAt: latest.updatedAt,
    });
  });
}
