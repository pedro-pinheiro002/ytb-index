/**
 * Unit tests for `createD1RestWriter` against a fake `fetchImpl` — zero
 * network. Covers chunking, wire shape, param mapping, response validation,
 * and retry/backoff behavior.
 *
 * Run via `pnpm test` (node:test runner).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { D1RestError, createD1RestWriter, type D1RestParam, type FetchLike } from './d1-http.ts';
import type { Statement } from './executor.ts';

/** One captured HTTP request. */
interface CapturedRequest {
  url: string;
  init: RequestInit;
}

/** One statement as it appears in a captured request body. */
interface WireStatement {
  sql: string;
  params: D1RestParam[];
}

/** JSON response with the API's documented shape. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A success body with `count` per-statement results. */
function okBody(count: number): unknown {
  return {
    success: true,
    errors: [],
    result: Array.from({ length: count }, () => ({ success: true, results: [], meta: {} })),
  };
}

/** Capture requests and answer from a queued list of responses. */
function captureFetch(responses: Response[]): {
  fetchImpl: FetchLike;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    requests.push({ url, init });
    const response = responses[requests.length - 1];
    if (response === undefined) throw new Error('fake fetch: no response queued');
    return response;
  };
  return { fetchImpl, requests };
}

/** Parse one captured request body's `batch`. */
function requestBatch(request: CapturedRequest): WireStatement[] {
  const body = JSON.parse(String(request.init.body)) as { batch: WireStatement[] };
  return body.batch;
}

/** Writer with deterministic config; tests override retry knobs as needed. */
function makeWriter(
  fetchImpl: FetchLike,
  options: {
    maxAttempts?: number;
    retryBaseMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): ReturnType<typeof createD1RestWriter> {
  return createD1RestWriter({
    accountId: 'acct-1',
    databaseId: 'db-1',
    token: 'token-1',
    fetchImpl,
    sleep: options.sleep ?? (async () => {}),
    maxAttempts: options.maxAttempts ?? 5,
    retryBaseMs: options.retryBaseMs ?? 500,
  });
}

describe('createD1RestWriter', () => {
  it('chunks statements into batches of at most 20 with the documented request shape', async () => {
    const { fetchImpl, requests } = captureFetch([
      jsonResponse(okBody(20)),
      jsonResponse(okBody(20)),
      jsonResponse(okBody(5)),
    ]);
    const writer = makeWriter(fetchImpl);

    const statements: Statement[] = Array.from({ length: 45 }, (_, index) => ({
      sql: `INSERT INTO t (n) VALUES (?) -- ${index}`,
      params: [index],
    }));
    await writer.apply(statements);

    assert.equal(requests.length, 3);
    const first = requests[0]!;
    const last = requests[2]!;
    assert.equal(
      first.url,
      'https://api.cloudflare.com/client/v4/accounts/acct-1/d1/database/db-1/query',
    );
    assert.equal(first.init.method, 'POST');
    assert.deepEqual(first.init.headers, {
      Authorization: 'Bearer token-1',
      'Content-Type': 'application/json',
    });
    assert.deepEqual(
      requests.map((request) => requestBatch(request).length),
      [20, 20, 5],
    );
    assert.deepEqual(requestBatch(first)[0], {
      sql: 'INSERT INTO t (n) VALUES (?) -- 0',
      params: ['0'],
    });
    assert.deepEqual(requestBatch(last)[4], {
      sql: 'INSERT INTO t (n) VALUES (?) -- 44',
      params: ['44'],
    });
  });

  it('stringifies numbers, passes strings through, and keeps JSON null', async () => {
    const { fetchImpl, requests } = captureFetch([jsonResponse(okBody(1))]);
    const writer = makeWriter(fetchImpl);

    await writer.apply([
      { sql: 'INSERT INTO t VALUES (?, ?, ?, ?)', params: ['text', 42, 3.5, null] },
    ]);

    assert.deepEqual(requestBatch(requests[0]!)[0], {
      sql: 'INSERT INTO t VALUES (?, ?, ?, ?)',
      params: ['text', '42', '3.5', null],
    });
  });

  it('sends an empty params array when a statement has none', async () => {
    const { fetchImpl, requests } = captureFetch([jsonResponse(okBody(1))]);
    const writer = makeWriter(fetchImpl);

    await writer.apply([{ sql: 'DELETE FROM videos' }]);

    assert.deepEqual(requestBatch(requests[0]!)[0], { sql: 'DELETE FROM videos', params: [] });
  });

  it('surfaces the D1 code, message, and statement index on a per-statement failure', async () => {
    const failureBody = {
      success: true,
      errors: [],
      result: [
        { success: true, results: [], meta: {} },
        { success: false, errors: [{ code: 7500, message: 'no such table: comments' }] },
      ],
    };
    const { fetchImpl } = captureFetch([jsonResponse(failureBody)]);
    const writer = makeWriter(fetchImpl);

    await assert.rejects(
      writer.apply([
        { sql: 'INSERT INTO channels (id) VALUES (?)', params: ['c1'] },
        { sql: 'INSERT INTO comments (id) VALUES (?)', params: ['c1'] },
      ]),
      (error: unknown) => {
        assert.ok(error instanceof D1RestError);
        assert.equal(error.code, 7500);
        assert.equal(error.statementIndex, 1);
        assert.match(error.message, /no such table: comments/);
        return true;
      },
    );
  });

  it('throws with the top-level D1 code and message when success is false', async () => {
    const failureBody = {
      success: false,
      errors: [{ code: 7003, message: 'invalid token' }],
      result: null,
    };
    const { fetchImpl } = captureFetch([jsonResponse(failureBody)]);
    const writer = makeWriter(fetchImpl);

    await assert.rejects(writer.apply([{ sql: 'SELECT 1' }]), (error: unknown) => {
      assert.ok(error instanceof D1RestError);
      assert.equal(error.code, 7003);
      assert.equal(error.status, 200);
      assert.match(error.message, /invalid token/);
      return true;
    });
  });

  it('rejects when the response has fewer results than statements', async () => {
    const { fetchImpl } = captureFetch([jsonResponse(okBody(1))]);
    const writer = makeWriter(fetchImpl);

    await assert.rejects(
      writer.apply([{ sql: 'SELECT 1' }, { sql: 'SELECT 2' }]),
      (error: unknown) => {
        assert.ok(error instanceof D1RestError);
        assert.match(error.message, /1 results for 2 statements/);
        return true;
      },
    );
  });

  it('retries 429 honoring retry-after, then succeeds', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response('rate limited', { status: 429, headers: { 'retry-after': '3' } });
      }
      return jsonResponse(okBody(1));
    };
    const writer = makeWriter(fetchImpl, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await writer.apply([{ sql: 'SELECT 1' }]);

    assert.equal(calls, 2);
    assert.deepEqual(sleeps, [3000]);
  });

  it('retries network errors and succeeds', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return jsonResponse(okBody(1));
    };
    const writer = makeWriter(fetchImpl);

    await writer.apply([{ sql: 'SELECT 1' }]);

    assert.equal(calls, 2);
  });

  it('gives up after maxAttempts with attempt context', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return new Response('boom', { status: 500 });
    };
    const writer = makeWriter(fetchImpl, {
      maxAttempts: 3,
      retryBaseMs: 10,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await assert.rejects(writer.apply([{ sql: 'SELECT 1' }]), (error: unknown) => {
      assert.ok(error instanceof D1RestError);
      assert.equal(error.attempts, 3);
      assert.equal(error.status, 500);
      assert.match(error.message, /3 attempts/);
      return true;
    });
    assert.equal(calls, 3);
    assert.equal(sleeps.length, 2);
    for (const [index, ms] of sleeps.entries()) {
      const exponential = 10 * 2 ** index;
      assert.ok(
        ms >= exponential * 0.5 && ms <= exponential,
        `sleep ${ms} outside [${exponential * 0.5}, ${exponential}]`,
      );
    }
  });

  it('does not call the API for an empty statement list', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse(okBody(0));
    };
    const writer = makeWriter(fetchImpl);

    await writer.apply([]);

    assert.equal(calls, 0);
  });
});
