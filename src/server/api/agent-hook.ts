/**
 * Sentry webhook receiver (`server/api/agent-hook`), mounted by `createApp`.
 *
 * `POST /api/agent-hook` — the only public write path the repair agent adds:
 *
 *   1. **Authenticate.** HMAC-SHA256 of the raw body must match the
 *      `sentry-hook-signature` header (Sentry Internal Integration client
 *      secret, `SENTRY_HOOK_SECRET`). Constant-time compare, fail closed (503
 *      when unconfigured, 401 on mismatch). The DSN is public, so this route
 *      must never trust the payload shape alone.
 *   2. **Filter.** Only `action: "created"`, only `error`/`fatal`, only issues
 *      that are still unresolved — a resolved issue must not re-open a run.
 *   3. **Debounce.** Best-effort, per-isolate (10 min per issue id). The
 *      authoritative dedup is the workflow's branch/PR check, because isolates
 *      are ephemeral and there is no cron here.
 *   4. **Dispatch.** `agent-diagnose` `repository_dispatch` with the issue
 *      coordinates; failure -> `502` so Sentry retries the delivery.
 *
 * `AGENT_ENABLED=false` is the kill switch: the route answers `503` and
 * nothing is dispatched.
 *
 * Only runtime globals (crypto.subtle, TextEncoder, fetch) are used, so this
 * module bundles for Workers.
 */
import type { Hono } from 'hono';
import {
  dispatchAgentDiagnosis,
  type AgentDispatchTransport,
  type AgentIssuePayload,
} from './github-agent-dispatch.ts';

/** Configuration for the agent hook; all fields optional (fail closed). */
export interface AgentHookConfig {
  /** Sentry Internal Integration client secret (`SENTRY_HOOK_SECRET`). */
  hookSecret?: string | undefined;
  /** Fine-grained GitHub PAT (`GH_DISPATCH_PAT`, shared with the ingest API). */
  dispatchPat?: string | undefined;
  /** GitHub owner (`GH_OWNER`, Worker var). */
  ghOwner?: string | undefined;
  /** GitHub repository name (`GH_REPO`, Worker var). */
  ghRepo?: string | undefined;
  /** Kill switch (`AGENT_ENABLED`, Worker var). Absent means enabled. */
  enabled?: boolean | undefined;
  /** Injectable dispatch transport; defaults to `globalThis.fetch`. */
  transport?: AgentDispatchTransport | undefined;
  /** Injectable clock for deterministic tests. */
  now?: (() => Date) | undefined;
}

/** Refuse bodies larger than this: a Sentry issue webhook is ~2 KB. */
const MAX_BODY_BYTES = 64 * 1024;

/** Per-isolate debounce window for one issue id. */
const DEDUP_TTL_MS = 10 * 60 * 1000;

/** Module scope on purpose: survives across requests in one isolate only. */
const recentIssues = new Map<string, number>();

/** Parse the subset of the Sentry `issue` resource payload this route needs. */
interface SentryIssueWebhook {
  action?: unknown;
  data?: {
    issue?: {
      id?: unknown;
      title?: unknown;
      level?: unknown;
      shortId?: unknown;
      permalink?: unknown;
      status?: unknown;
      fingerprint?: unknown;
    };
  };
}

/** Header values are untrusted strings; narrow one to a non-empty string. */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Hex-encode a digest without Buffer (Workers-safe). */
function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

/** Length-independent comparison so timing cannot leak the expected digest. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Verify `Sentry-Hook-Signature`: HMAC-SHA256 hex of the *raw* body, keyed by
 * the integration client secret. Parsing and re-serializing would change the
 * bytes and break the digest, so callers must pass `c.req.text()` verbatim.
 */
export async function verifySentrySignature(
  secret: string,
  rawBody: string,
  signature: string,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  return timingSafeEqual(toHex(new Uint8Array(digest)), signature.toLowerCase());
}

/** Normalize a Sentry `data.issue` object into the dispatch payload. */
export function toIssuePayload(
  issue: NonNullable<SentryIssueWebhook['data']>['issue'],
): AgentIssuePayload | undefined {
  const id = asString(issue?.id);
  const title = asString(issue?.title);
  if (id === undefined || title === undefined) {
    return undefined;
  }
  return {
    issueId: id,
    title,
    level: asString(issue?.level) ?? 'error',
    shortId: asString(issue?.shortId) ?? id,
    fingerprint: asString(issue?.fingerprint) ?? id,
    permalink: asString(issue?.permalink) ?? '',
  };
}

/**
 * Mount `POST /api/agent-hook` on `app`.
 *
 * Returns `202` for both "dispatched" and "ignored" so Sentry stops retrying
 * on payloads we deliberately skip; only real failures surface as `5xx`.
 */
export function agentHookRoute(app: Hono, config: AgentHookConfig): void {
  const {
    hookSecret,
    dispatchPat,
    ghOwner,
    ghRepo,
    enabled = true,
    transport,
    now = () => new Date(),
  } = config;

  app.post('/api/agent-hook', async (c) => {
    if (
      !enabled ||
      hookSecret === undefined ||
      dispatchPat === undefined ||
      ghOwner === undefined ||
      ghRepo === undefined
    ) {
      return c.json({ error: 'agent hook disabled' }, 503);
    }

    const rawBody = await c.req.text();
    if (rawBody.length > MAX_BODY_BYTES) {
      return c.json({ error: 'body too large' }, 413);
    }

    const signature = c.req.header('sentry-hook-signature') ?? '';
    if (signature === '' || !(await verifySentrySignature(hookSecret, rawBody, signature))) {
      return c.json({ error: 'invalid signature' }, 401);
    }

    let payload: SentryIssueWebhook;
    try {
      payload = JSON.parse(rawBody) as SentryIssueWebhook;
    } catch {
      return c.json({ error: 'invalid json' }, 400);
    }

    const issue = payload.data?.issue;
    const issuePayload = toIssuePayload(issue);
    if (payload.action !== 'created' || issuePayload === undefined) {
      return c.json({ ignored: 'not a created issue' }, 202);
    }
    if (issuePayload.level !== 'error' && issuePayload.level !== 'fatal') {
      return c.json({ ignored: 'level' }, 202);
    }
    if (issue?.status === 'resolved' || issue?.status === 'ignored') {
      return c.json({ ignored: 'status' }, 202);
    }

    const at = now().getTime();
    const last = recentIssues.get(issuePayload.issueId);
    if (last !== undefined && at - last < DEDUP_TTL_MS) {
      return c.json({ ignored: 'debounced' }, 202);
    }
    recentIssues.set(issuePayload.issueId, at);

    try {
      await dispatchAgentDiagnosis({
        owner: ghOwner,
        repo: ghRepo,
        pat: dispatchPat,
        issue: issuePayload,
        ...(transport === undefined ? {} : { transport }),
      });
    } catch (error) {
      // Let Sentry retry: drop the debounce entry so the retry is not swallowed.
      recentIssues.delete(issuePayload.issueId);
      console.error('agent dispatch failed', error);
      return c.json({ error: 'dispatch failed' }, 502);
    }

    return c.json({ dispatched: issuePayload.shortId }, 202);
  });
}
