/**
 * OperatorKey check (`server/api/key-check`), F6 (#51), ADR-0007.
 *
 * `POST /api/key/check` — gated by the operator token like every write
 * (ADR-0005), so anonymous callers cannot probe keys or spend quota. Body
 * `{ key }`; answers `200` with a verdict `{ ok: true }` or
 * `{ ok: false, reason, message }` (spec v2 "OperatorKey check contract"):
 *   1. Local shape check (`^AIza[A-Za-z0-9_-]{30,50}$`). This is the server's
 *      own copy: `server` never imports `src/yt` (ADR-0002/0003, amended by
 *      ADR-0007 for exactly this one outbound call).
 *   2. One `channels.list?part=id` call (1 unit) against a fixed public
 *      channel, through an injectable transport (`fetch` by default).
 *   3. The Google error envelope is mapped to a {@link KeyCheckReason}.
 *
 * {@link checkOperatorKey} is also what `POST /api/ingest` runs before it
 * seals an OperatorKey. The key is never echoed in a verdict and never logged.
 */
import type { Hono } from 'hono';
import { isOperatorAuthorized } from './operator-auth.ts';

/** The narrow fetch surface the key check needs (also the test seam). */
export type KeyCheckTransport = (url: string, init?: RequestInit) => Promise<Response>;

/** Why an OperatorKey was refused (spec v2). */
export type KeyCheckReason =
  | 'missing'
  | 'malformed'
  | 'invalid'
  | 'quotaExceeded'
  | 'apiNotEnabled'
  | 'restricted'
  | 'unavailable';

/** The verdict of one OperatorKey check. */
export type KeyCheckVerdict = { ok: true } | { ok: false; reason: KeyCheckReason; message: string };

/** Configuration for {@link keyCheckRoute}. */
export interface KeyCheckRouteConfig {
  /** Shared operator token (`OPERATOR_TOKEN`). Missing → every call is 401. */
  operatorToken?: string | undefined;
  /** Injectable transport for the YouTube probe; defaults to `globalThis.fetch`. */
  keyCheckTransport?: KeyCheckTransport | undefined;
}

const KEY_SHAPE = /^AIza[A-Za-z0-9_-]{30,50}$/;

/** A long-lived public channel (Google for Developers) used as the probe target. */
const PROBE_CHANNEL_ID = 'UC_x5XG1OV2P6uZZ5FSM9Ttw';
const PROBE_URL = 'https://www.googleapis.com/youtube/v3/channels';

/** Operator-facing message for each refusal reason. */
const MESSAGES: Record<KeyCheckReason, string> = {
  missing: 'Paste a YouTube Data API key first.',
  malformed: 'That does not look like a YouTube Data API key (expected "AIza" + ~35 characters).',
  invalid: 'Google rejected this key as invalid. Check that it was copied whole and not deleted.',
  quotaExceeded:
    "This key's YouTube Data API quota is used up for today. It resets at midnight Pacific Time.",
  apiNotEnabled:
    "The YouTube Data API v3 is not enabled in this key's Google Cloud project. Enable it and try again.",
  restricted:
    'This key is restricted (HTTP referrer, IP or API restrictions) and cannot be used from the server. Relax the restriction or use another key.',
  unavailable: 'Could not reach YouTube to check the key. Try again in a moment.',
};

function refuse(reason: KeyCheckReason): KeyCheckVerdict {
  return { ok: false, reason, message: MESSAGES[reason] };
}

/** The reason strings found in a Google error envelope (`errors[].reason`, `details[].reason`, `status`). */
function envelopeSignals(body: unknown): Set<string> {
  const signals = new Set<string>();
  const error = (body as { error?: unknown } | null | undefined)?.error;
  if (error === null || typeof error !== 'object') return signals;
  const { errors, details, status } = error as {
    errors?: unknown;
    details?: unknown;
    status?: unknown;
  };
  if (typeof status === 'string') signals.add(status);
  for (const list of [errors, details]) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const reason = (entry as { reason?: unknown } | null | undefined)?.reason;
      if (typeof reason === 'string') signals.add(reason);
    }
  }
  return signals;
}

const INVALID_SIGNALS = ['keyInvalid', 'API_KEY_INVALID', 'INVALID_ARGUMENT'];
// `rateLimitExceeded` is a short-term rate limit, not the daily quota: it
// falls through to `unavailable` (try again) instead of the midnight-PT message.
const QUOTA_SIGNALS = ['quotaExceeded', 'dailyLimitExceeded'];
const NOT_ENABLED_SIGNALS = ['accessNotConfigured', 'SERVICE_DISABLED'];
const RESTRICTED_SIGNALS = [
  'ipRefererBlocked',
  'forbidden',
  'API_KEY_HTTP_REFERRER_BLOCKED',
  'API_KEY_IP_ADDRESS_BLOCKED',
  'API_KEY_ANDROID_APP_BLOCKED',
  'API_KEY_IOS_APP_BLOCKED',
  'API_KEY_SERVICE_BLOCKED',
];

/** Map a non-OK YouTube response to a refusal reason. */
function reasonFor(status: number, signals: Set<string>): KeyCheckReason {
  const has = (list: string[]): boolean => list.some((signal) => signals.has(signal));
  if (status >= 500) return 'unavailable';
  if (has(QUOTA_SIGNALS)) return 'quotaExceeded';
  if (has(NOT_ENABLED_SIGNALS)) return 'apiNotEnabled';
  if (has(RESTRICTED_SIGNALS)) return 'restricted';
  if (status === 400 && has(INVALID_SIGNALS)) return 'invalid';
  // Anything else (an envelope we do not recognize) could not be verified.
  return 'unavailable';
}

/**
 * Check an OperatorKey: local shape first, then one `channels.list?part=id`
 * probe. Never throws; network errors and 5xx become `unavailable`.
 */
export async function checkOperatorKey(
  key: unknown,
  transport: KeyCheckTransport = (url, init) => globalThis.fetch(url, init),
): Promise<KeyCheckVerdict> {
  if (key === undefined || key === null || (typeof key === 'string' && key.trim() === '')) {
    return refuse('missing');
  }
  if (typeof key !== 'string' || !KEY_SHAPE.test(key)) {
    return refuse('malformed');
  }

  const url = new URL(PROBE_URL);
  url.searchParams.set('part', 'id');
  url.searchParams.set('id', PROBE_CHANNEL_ID);
  url.searchParams.set('key', key);

  let response: Response;
  try {
    response = await transport(url.toString(), { headers: { accept: 'application/json' } });
  } catch {
    return refuse('unavailable');
  }
  if (response.ok) return { ok: true };

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Not a Google envelope; fall through with no signals.
  }
  return refuse(reasonFor(response.status, envelopeSignals(body)));
}

/** Mount `POST /api/key/check` on `app` (mounted by `createApp`). */
export function keyCheckRoute(app: Hono, config: KeyCheckRouteConfig = {}): void {
  app.post('/api/key/check', async (c) => {
    if (!isOperatorAuthorized(c.req.header('authorization'), config.operatorToken)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const key = (body as { key?: unknown } | null | undefined)?.key;
    return c.json(await checkOperatorKey(key, config.keyCheckTransport));
  });
}
