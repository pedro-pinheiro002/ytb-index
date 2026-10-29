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
 *      (`./github-dispatch.ts`) carrying `{ requestId, channel,
 *      sealedKey?, captureLiveChat }`.
 *
 *   F6 (#51, ADR-0007/0008): the body is `{ channel, key?, captureLiveChat? }`.
 *   With a `key` (an OperatorKey) the route fails closed with `503` when
 *   `INGEST_SEAL_PUBLIC_KEY` is not configured, runs the same check as
 *   `POST /api/key/check` (refusal -> `422 { reason, message }`), seals the
 *   key (`./seal.ts`) and records `key_source = 'operator'`. No IngestRequest
 *   row is created on a 503 or 422. Without a key the repo `YOUTUBE_API_KEY`
 *   pays (`key_source = 'repo'`). The plaintext key is never stored, logged
 *   or dispatched.
 *   5. Dispatch failure -> row marked `failed` (error: "dispatch failed"),
 *      response `502`; success -> `202 { requestId }`.
 *
 * `GET /api/ingest/status` — public read of the latest IngestRequest as
 * `{ requestId, channelId, status, videosWritten, commentsWritten, error,
 * updatedAt }`. When no request exists it answers **`204 No Content`** (no
 * body); callers treat 204 as "nothing yet".
 *
 * The module only uses runtime globals (fetch, crypto.randomUUID, crypto.subtle)
 * plus portable SQL through the `Executor`, so it bundles for Workers.
 */
import type { Hono } from 'hono';
import type { Executor } from '../../db/executor.ts';
import { loadLatestIngestStatus } from '../data.ts';
import { normalizeChannelInput } from './channel-input.ts';
import { dispatchIngest, type DispatchTransport } from './github-dispatch.ts';
import { checkOperatorKey, type KeyCheckTransport } from './key-check.ts';
import { isOperatorAuthorized } from './operator-auth.ts';
import { sealOperatorKey } from './seal.ts';

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
  /**
   * Public RSA-OAEP JWK (JSON text) the OperatorKey is sealed under
   * (`INGEST_SEAL_PUBLIC_KEY`, Worker var, ADR-0008). Missing/empty: a
   * trigger carrying a key fails closed with `503`.
   */
  sealPublicKey?: string | undefined;
  /** Injectable transport for the OperatorKey probe; defaults to `globalThis.fetch`. */
  keyCheckTransport?: KeyCheckTransport | undefined;
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

/**
 * An active request with no status write for this long is presumed dead
 * (ADR-0005). The runner job is capped at 360 min (`timeout-minutes`) and
 * writes `running` right after it starts, so a `running` row older than this
 * cannot belong to a live job. A `queued` row this old means the dispatch was
 * never picked up.
 */
const STALE_ACTIVE_AFTER_MS = 6 * 60 * 60 * 1000;

const RECLAIM_STALE_REQUESTS_SQL = `
  UPDATE ingest_requests
  SET status = 'failed', error = ?, updated_at = ?, finished_at = ?
  WHERE channel_key = ? AND status IN ('queued', 'running') AND updated_at < ?
`;

const INSERT_REQUEST_SQL = `
  INSERT INTO ingest_requests (
    id, channel_input, channel_key, channel_id, status,
    videos_written, comments_written, error, created_at, updated_at, finished_at,
    key_source, capture_live_chat
  )
  VALUES (?, ?, ?, NULL, 'queued', 0, 0, NULL, ?, ?, NULL, ?, ?)
`;

const MARK_REQUEST_FAILED_SQL = `
  UPDATE ingest_requests
  SET status = 'failed', error = ?, updated_at = ?, finished_at = ?
  WHERE id = ?
`;

/**
 * Mount the ingest API on `app`. `db` is the executor owned by the app
 * factory; `config` carries the Worker bindings (or `.env` values locally).
 */
export function ingestApiRoute(app: Hono, db: Executor, config: IngestApiConfig = {}): void {
  const now = config.now ?? ((): Date => new Date());
  const uuid = config.uuid ?? ((): string => crypto.randomUUID());

  app.post('/api/ingest', async (c) => {
    if (!isOperatorAuthorized(c.req.header('authorization'), config.operatorToken)) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const fields = (body ?? {}) as { channel?: unknown; key?: unknown; captureLiveChat?: unknown };
    const channel = fields.channel;
    if (typeof channel !== 'string') {
      return c.json({ error: 'body must be {"channel": "<@handle | UC… id | YouTube URL>"}' }, 400);
    }
    const normalized = normalizeChannelInput(channel);
    if (!normalized.ok) {
      return c.json({ error: normalized.error }, 400);
    }
    if (fields.captureLiveChat !== undefined && typeof fields.captureLiveChat !== 'boolean') {
      return c.json({ error: 'captureLiveChat must be a boolean' }, 400);
    }
    const captureLiveChat = fields.captureLiveChat ?? false;
    // `null` is treated like an absent key: the repo key pays.
    const operatorKey = fields.key ?? undefined;
    if (operatorKey !== undefined && (config.sealPublicKey ?? '') === '') {
      // ADR-0008: never fall back to dispatching the key unsealed.
      return c.json(
        { error: 'OperatorKey ingest is not configured (INGEST_SEAL_PUBLIC_KEY)' },
        503,
      );
    }

    const nowDate = now();
    await db.run(RECLAIM_STALE_REQUESTS_SQL, [
      'stale: no status update within the runner time limit',
      nowDate.toISOString(),
      nowDate.toISOString(),
      normalized.channelKey,
      new Date(nowDate.getTime() - STALE_ACTIVE_AFTER_MS).toISOString(),
    ]);

    const active = await db.get<{ id: string }>(SELECT_ACTIVE_REQUEST_SQL, [normalized.channelKey]);
    if (active !== undefined) {
      return c.json({ requestId: active.id }, 409);
    }

    let sealedKey: string | undefined;
    if (operatorKey !== undefined) {
      const verdict = await checkOperatorKey(operatorKey, config.keyCheckTransport);
      if (!verdict.ok) {
        return c.json({ reason: verdict.reason, message: verdict.message }, 422);
      }
      try {
        sealedKey = await sealOperatorKey(operatorKey as string, config.sealPublicKey ?? '');
      } catch {
        return c.json({ error: 'INGEST_SEAL_PUBLIC_KEY is not a usable public JWK' }, 503);
      }
    }

    const requestId = uuid();
    const createdAt = nowDate.toISOString();
    try {
      await db.run(INSERT_REQUEST_SQL, [
        requestId,
        channel,
        normalized.channelKey,
        createdAt,
        createdAt,
        sealedKey !== undefined ? 'operator' : 'repo',
        captureLiveChat ? 1 : 0,
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
        sealedKey,
        captureLiveChat,
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
