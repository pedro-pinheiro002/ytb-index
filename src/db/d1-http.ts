/**
 * D1 HTTP API writer for remote ingest (`db/d1-http`).
 *
 * Deliberately NOT an `Executor` implementation: `Executor.batch` promises
 * all-or-nothing atomicity, while the D1 HTTP API's `batch` endpoint only
 * documents per-call execution, not a transaction. Instead `apply()` chunks a
 * statement list into best-effort calls; the write path stays safe to re-run
 * because every upsert is idempotent (`ON CONFLICT`) and a full re-ingest
 * overwrites the partial state (ADR-0001 / ADR-0003).
 *
 * No env reads and no hidden state: credentials, fetch, and sleep are all
 * injected, so the writer is unit-testable without network.
 */
import type { Statement } from './executor.ts';

/** Statements per HTTP call (conservative; the API allows far more). */
const DEFAULT_CHUNK_SIZE = 20;
/** Attempts per call, including the first. */
const DEFAULT_MAX_ATTEMPTS = 5;
/** Base for exponential backoff (ms). */
const DEFAULT_RETRY_BASE_MS = 500;

/** A parameter value as sent on the wire (numbers are stringified). */
export type D1RestParam = string | null;

/** Minimal fetch surface — injectable for tests. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Options for {@link createD1RestWriter}. */
export interface D1RestWriterOptions {
  accountId: string;
  databaseId: string;
  /** API token with D1 Write permission. */
  token: string;
  /** Injectable fetch. Defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Statements per HTTP call. Defaults to 20. */
  chunkSize?: number;
  /** Attempts per call incl. the first. Defaults to 5. */
  maxAttempts?: number;
  /** Base for exponential backoff (ms). Defaults to 500. */
  retryBaseMs?: number;
  /** Injectable sleep (tests use a no-op). Defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

/** Best-effort, chunked writer for one ingest run. */
export interface D1RestWriter {
  /** Send every statement in order; resolves once all chunks have succeeded. */
  apply(statements: Statement[]): Promise<void>;
}

/** Thrown when the D1 HTTP API rejects a call or all retries are exhausted. */
export class D1RestError extends Error {
  override readonly name = 'D1RestError';
  /** D1 error code, when the API supplied one. */
  readonly code: number | string | undefined;
  /** Index of the offending statement in the original `apply()` list. */
  readonly statementIndex: number | undefined;
  /** HTTP status, when the failure came with a response. */
  readonly status: number | undefined;
  /** Attempts made for the failing call. */
  readonly attempts: number | undefined;

  constructor(
    message: string,
    details: {
      code?: number | string | undefined;
      statementIndex?: number | undefined;
      status?: number | undefined;
      attempts?: number | undefined;
    } = {},
  ) {
    super(message);
    this.code = details.code;
    this.statementIndex = details.statementIndex;
    this.status = details.status;
    this.attempts = details.attempts;
  }
}

/** One statement as sent on the wire. */
interface D1WireStatement {
  sql: string;
  params: D1RestParam[];
}

interface D1ApiError {
  code?: number;
  message?: string;
}

interface D1StatementResult {
  success?: boolean;
  errors?: D1ApiError[];
}

interface D1ResponseBody {
  success?: boolean;
  errors?: D1ApiError[];
  result?: D1StatementResult[] | null;
}

/** Format a D1 API error as `code <n>: <message>`. */
function describeApiError(error: D1ApiError): string {
  const code = error.code === undefined ? '' : `code ${error.code}: `;
  return `${code}${error.message ?? 'unknown error'}`;
}

/** `Error.message` for anything throwable. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Exponential backoff with 50–100% jitter. */
function backoffMs(attempt: number, baseMs: number): number {
  const exponential = baseMs * 2 ** (attempt - 1);
  return Math.round(exponential * (0.5 + Math.random() * 0.5));
}

/** `retry-after` (seconds) when present, else jittered exponential backoff. */
function retryDelayMs(response: Response, attempt: number, baseMs: number): number {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  }
  return backoffMs(attempt, baseMs);
}

/** Map one bound value to the API's wire shape. */
function toWireParam(value: unknown, statementIndex: number, paramIndex: number): D1RestParam {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  throw new D1RestError(
    `unsupported parameter type at statement ${statementIndex} param ${paramIndex}: ${typeof value}`,
    { statementIndex },
  );
}

/** `POST .../query` URL for one D1 database. */
function queryUrl(accountId: string, databaseId: string): string {
  const account = encodeURIComponent(accountId);
  const database = encodeURIComponent(databaseId);
  return `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`;
}

/**
 * Create a writer bound to one D1 database.
 *
 * Each `apply()` call sends `ceil(statements / chunkSize)` HTTP requests. A
 * chunk that fails after `maxAttempts` rejects with {@link D1RestError};
 * earlier chunks stay applied, which is acceptable because the statements are
 * idempotent upserts (re-run to repair).
 */
export function createD1RestWriter(options: D1RestWriterOptions): D1RestWriter {
  const {
    accountId,
    databaseId,
    token,
    fetchImpl = globalThis.fetch,
    chunkSize = DEFAULT_CHUNK_SIZE,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    retryBaseMs = DEFAULT_RETRY_BASE_MS,
    sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;

  const url = queryUrl(accountId, databaseId);

  /** Validate a 2xx response body; throws on any failure. */
  async function validateResponse(
    response: Response,
    expectedCount: number,
    chunkStart: number,
  ): Promise<void> {
    let body: D1ResponseBody;
    try {
      body = (await response.json()) as D1ResponseBody;
    } catch {
      throw new D1RestError(`D1 HTTP API returned unreadable JSON (HTTP ${response.status})`, {
        status: response.status,
      });
    }

    const apiErrors = body.errors ?? [];
    if (body.success !== true || apiErrors.length > 0) {
      const first = apiErrors[0];
      const detail = first === undefined ? `HTTP ${response.status}` : describeApiError(first);
      throw new D1RestError(`D1 HTTP API rejected the batch: ${detail}`, {
        status: response.status,
        code: first?.code,
      });
    }

    const results = body.result ?? [];
    if (results.length !== expectedCount) {
      throw new D1RestError(
        `D1 HTTP API returned ${results.length} results for ${expectedCount} statements`,
        { status: response.status },
      );
    }

    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      if (result?.success !== true) {
        const first = result?.errors?.[0] ?? apiErrors[0];
        const detail = first === undefined ? 'unknown error' : describeApiError(first);
        throw new D1RestError(`D1 statement ${chunkStart + index} failed: ${detail}`, {
          status: response.status,
          code: first?.code,
          statementIndex: chunkStart + index,
        });
      }
    }
  }

  /** One chunk, retrying 429 / 5xx / network errors. */
  async function request(batch: D1WireStatement[], chunkStart: number): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ batch }),
        });
      } catch (err) {
        if (attempt === maxAttempts) {
          throw new D1RestError(
            `D1 HTTP request failed after ${attempt} attempts: ${errorMessage(err)}`,
            { attempts: attempt },
          );
        }
        await sleep(backoffMs(attempt, retryBaseMs));
        continue;
      }

      if (response.status === 429 || response.status >= 500) {
        if (attempt === maxAttempts) {
          throw new D1RestError(
            `D1 HTTP request failed after ${attempt} attempts: HTTP ${response.status}`,
            { status: response.status, attempts: attempt },
          );
        }
        await sleep(retryDelayMs(response, attempt, retryBaseMs));
        continue;
      }

      await validateResponse(response, batch.length, chunkStart);
      return;
    }
  }

  return {
    async apply(statements: Statement[]): Promise<void> {
      for (let offset = 0; offset < statements.length; offset += chunkSize) {
        const chunk = statements.slice(offset, offset + chunkSize);
        const batch = chunk.map((statement, index) => ({
          sql: statement.sql,
          params: (statement.params ?? []).map((param, paramIndex) =>
            toWireParam(param, offset + index, paramIndex),
          ),
        }));
        await request(batch, offset);
      }
    },
  };
}
