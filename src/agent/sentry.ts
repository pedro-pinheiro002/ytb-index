/**
 * Minimal Sentry REST client (`src/agent/sentry`).
 *
 * The webhook only carries the issue *envelope*; the stack trace, the event
 * tags, and the breadcrumbs all live behind the API. One token with
 * `event:read` + `project:read` is enough, and the same token is **not** the
 * one that can deploy anything.
 */

/** A stack frame, normalized from either Sentry event shape. */
export interface SentryFrame {
  filename: string;
  fn: string;
  lineNo: number | undefined;
  inApp: boolean;
  contextLine: string | undefined;
}

/** The event fields the agent actually reads. */
export interface SentryEvent {
  eventId: string;
  title: string;
  message: string;
  platform: string;
  tags: Record<string, string>;
  frames: SentryFrame[];
}

/** The issue fields the agent actually reads. */
export interface SentryIssue {
  id: string;
  shortId: string;
  title: string;
  culprit: string;
  level: string;
  status: string;
  count: string;
  firstSeen: string;
  lastSeen: string;
  permalink: string;
  metadata: { type?: string; value?: string; filename?: string };
}

/** Loose shapes for the JSON we consume; every field is re-checked on read. */
type Json = Record<string, unknown>;

/** Narrow an unknown to an object. */
function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read a string field, or `undefined`. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** GET a Sentry API path and parse JSON, with a bounded error message. */
async function getJson(url: string, token: string): Promise<Json> {
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'user-agent': 'ytb-index-agent',
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`sentry ${response.status} for ${url}: ${body.slice(0, 300)}`);
  }
  const parsed: unknown = await response.json();
  if (!isObject(parsed)) {
    throw new Error(`sentry returned a non-object for ${url}`);
  }
  return parsed;
}

/** Fetch one issue by id (`/api/0/issues/{id}/`). */
export async function fetchIssue(
  baseUrl: string,
  token: string,
  issueId: string,
): Promise<SentryIssue> {
  const raw = await getJson(`${baseUrl}/api/0/issues/${encodeURIComponent(issueId)}/`, token);
  const rawMetadata = isObject(raw.metadata) ? raw.metadata : {};
  const metadata: SentryIssue['metadata'] = {};
  const type = str(rawMetadata.type);
  const value = str(rawMetadata.value);
  const filename = str(rawMetadata.filename);
  if (type !== undefined) {
    metadata.type = type;
  }
  if (value !== undefined) {
    metadata.value = value;
  }
  if (filename !== undefined) {
    metadata.filename = filename;
  }

  return {
    id: str(raw.id) ?? issueId,
    shortId: str(raw.shortId) ?? issueId,
    title: str(raw.title) ?? '(untitled)',
    culprit: str(raw.culprit) ?? '',
    level: str(raw.level) ?? 'error',
    status: str(raw.status) ?? 'unresolved',
    count: String(raw.count ?? '?'),
    firstSeen: str(raw.firstSeen) ?? '',
    lastSeen: str(raw.lastSeen) ?? '',
    permalink: str(raw.permalink) ?? '',
    metadata,
  };
}

/** Pull `exception.values[*].stacktrace.frames[*]` from either event shape. */
function extractValues(event: Json): Json[] {
  const values: Json[] = [];

  const exception = event.exception;
  if (isObject(exception) && Array.isArray(exception.values)) {
    values.push(...exception.values.filter(isObject));
  }

  const entries = event.entries;
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (!isObject(entry) || entry.type !== 'exception' || !isObject(entry.data)) {
        continue;
      }
      const data = entry.data;
      if (Array.isArray(data.values)) {
        values.push(...data.values.filter(isObject));
      }
    }
  }

  return values;
}

/** Normalize frames, innermost last, keeping only what the prompt needs. */
function extractFrames(event: Json): SentryFrame[] {
  const frames: SentryFrame[] = [];
  for (const value of extractValues(event)) {
    const stacktrace = value.stacktrace;
    if (!isObject(stacktrace) || !Array.isArray(stacktrace.frames)) {
      continue;
    }
    for (const frame of stacktrace.frames) {
      if (!isObject(frame)) {
        continue;
      }
      const filename = str(frame.filename) ?? str(frame.absPath) ?? '';
      if (filename === '') {
        continue;
      }
      const lineNo = typeof frame.lineno === 'number' ? frame.lineno : undefined;
      frames.push({
        filename,
        fn: str(frame.function) ?? '(anonymous)',
        lineNo,
        inApp: frame.inApp === true,
        contextLine: str(frame.context_line),
      });
    }
  }
  return frames;
}

/** Fetch the latest event for an issue and flatten it for the prompt. */
export async function fetchLatestEvent(
  baseUrl: string,
  token: string,
  issueId: string,
): Promise<SentryEvent> {
  const raw = await getJson(
    `${baseUrl}/api/0/issues/${encodeURIComponent(issueId)}/events/latest/`,
    token,
  );

  const tags: Record<string, string> = {};
  if (Array.isArray(raw.tags)) {
    for (const tag of raw.tags) {
      if (isObject(tag)) {
        const key = str(tag.key);
        const value = str(tag.value);
        if (key !== undefined && value !== undefined) {
          tags[key] = value;
        }
      }
    }
  }

  return {
    eventId: str(raw.eventID) ?? '',
    title: str(raw.title) ?? '',
    message: str(raw.message) ?? '',
    platform: str(raw.platform) ?? '',
    tags,
    frames: extractFrames(raw),
  };
}
