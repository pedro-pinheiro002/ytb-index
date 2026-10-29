/**
 * Unit tests for `createIngestStatusReporter` (#ADR-0005 status reporting).
 *
 * Everything runs against a fake `D1RestWriter` — no network. Covers the SQL
 * shape of each lifecycle update, error truncation, and the best-effort
 * contract (a failed write warns and resolves, never rejects).
 *
 * Run via `pnpm test` (node:test runner).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { D1RestWriter } from '../db/d1-http.ts';
import type { Statement } from '../db/executor.ts';
import {
  STATUS_ERROR_MAX_CHARS,
  createIngestStatusReporter,
  truncateStatusError,
} from './status.ts';

const FIXED_NOW = (): Date => new Date('2026-03-01T00:00:00Z');
const FIXED_ISO = '2026-03-01T00:00:00.000Z';

/** Fake `D1RestWriter` recording every `apply()` call. */
function fakeWriter(): { writer: D1RestWriter; applied: Statement[][] } {
  const applied: Statement[][] = [];
  return {
    writer: {
      async apply(statements) {
        applied.push(statements);
      },
    },
    applied,
  };
}

describe('createIngestStatusReporter', () => {
  it('marks the request running with the resolved channel id and updated_at', async () => {
    const { writer, applied } = fakeWriter();
    const reporter = createIngestStatusReporter({ requestId: 'req-1', writer, now: FIXED_NOW });

    await reporter.running('UC_test_channel');

    assert.equal(applied.length, 1);
    const [statement] = applied[0]!;
    assert.match(statement!.sql, /UPDATE ingest_requests/);
    assert.match(statement!.sql, /status = 'running'/);
    assert.match(statement!.sql, /channel_id = \?/);
    assert.deepEqual(statement!.params, ['UC_test_channel', FIXED_ISO, 'req-1']);
  });

  it('marks the request done with the final counts, updated_at, and finished_at', async () => {
    const { writer, applied } = fakeWriter();
    const reporter = createIngestStatusReporter({ requestId: 'req-2', writer, now: FIXED_NOW });

    await reporter.complete({
      videos: 12,
      comments: 345,
      replies: 67,
      // F3b (#52): upcoming Broadcasts plus videos whose comments were not captured.
      skippedVideos: 2,
      quotaUsed: 890,
      chatMessages: 31,
    });

    assert.equal(applied.length, 1);
    const [statement] = applied[0]!;
    assert.match(statement!.sql, /status = 'done'/);
    assert.match(statement!.sql, /videos_written = \?/);
    assert.match(statement!.sql, /comments_written = \?/);
    assert.match(statement!.sql, /replies_written = \?/);
    assert.match(statement!.sql, /skipped_videos = \?/);
    assert.match(statement!.sql, /quota_used = \?/);
    assert.match(statement!.sql, /chat_messages_written = \?/);
    assert.match(statement!.sql, /updated_at = \?/);
    assert.match(statement!.sql, /finished_at = \?/);
    assert.deepEqual(statement!.params, [12, 345, 67, 2, 890, 31, FIXED_ISO, FIXED_ISO, 'req-2']);
  });

  it('reports quota_used with failed when the run knows it', async () => {
    const { writer, applied } = fakeWriter();
    const reporter = createIngestStatusReporter({ requestId: 'req-8', writer, now: FIXED_NOW });

    await reporter.failed('boom', { quotaUsed: 42 });

    const [statement] = applied[0]!;
    assert.match(statement!.sql, /status = 'failed'/);
    assert.match(statement!.sql, /quota_used = \?/);
    assert.doesNotMatch(statement!.sql, /chat_messages_written/);
    assert.deepEqual(statement!.params, ['boom', FIXED_ISO, FIXED_ISO, 42, 'req-8']);
  });

  it('reports chat_messages_written with failed when capture had started (F3b)', async () => {
    const { writer, applied } = fakeWriter();
    const reporter = createIngestStatusReporter({ requestId: 'req-10', writer, now: FIXED_NOW });

    await reporter.failed('boom', { quotaUsed: 42, chatMessages: 7 });

    const [statement] = applied[0]!;
    assert.match(statement!.sql, /quota_used = \?, chat_messages_written = \?/);
    assert.deepEqual(statement!.params, ['boom', FIXED_ISO, FIXED_ISO, 42, 7, 'req-10']);
  });

  it('leaves quota_used alone on a failed update without progress', async () => {
    const { writer, applied } = fakeWriter();
    const reporter = createIngestStatusReporter({ requestId: 'req-9', writer, now: FIXED_NOW });

    await reporter.failed('boom');

    assert.doesNotMatch(applied[0]![0]!.sql, /quota_used/);
  });

  it('marks the request failed with the error message, updated_at, and finished_at', async () => {
    const { writer, applied } = fakeWriter();
    const reporter = createIngestStatusReporter({ requestId: 'req-3', writer, now: FIXED_NOW });

    await reporter.failed('YouTube API error (HTTP 500)');

    assert.equal(applied.length, 1);
    const [statement] = applied[0]!;
    assert.match(statement!.sql, /status = 'failed'/);
    assert.match(statement!.sql, /error = \?/);
    assert.match(statement!.sql, /updated_at = \?/);
    assert.match(statement!.sql, /finished_at = \?/);
    assert.deepEqual(statement!.params, [
      'YouTube API error (HTTP 500)',
      FIXED_ISO,
      FIXED_ISO,
      'req-3',
    ]);
  });

  it('truncates a long error message to 500 chars on the failed update', async () => {
    const { writer, applied } = fakeWriter();
    const reporter = createIngestStatusReporter({ requestId: 'req-4', writer, now: FIXED_NOW });

    await reporter.failed('x'.repeat(800));

    const params = applied[0]![0]!.params as unknown[];
    const stored = params[0] as string;
    assert.equal(stored.length, STATUS_ERROR_MAX_CHARS);
    assert.equal(stored, 'x'.repeat(STATUS_ERROR_MAX_CHARS));
  });

  it('supports a failed-only lifecycle for pre-start failures', async () => {
    const { writer, applied } = fakeWriter();
    const reporter = createIngestStatusReporter({ requestId: 'req-7', writer, now: FIXED_NOW });

    // Pre-start failures (bad API key / channel input) never report `running`.
    await reporter.failed('Error: YOUTUBE_API_KEY is not set. Add it to your .env file.');

    assert.equal(applied.length, 1);
    const [statement] = applied[0]!;
    assert.match(statement!.sql, /status = 'failed'/);
    assert.deepEqual(statement!.params, [
      'Error: YOUTUBE_API_KEY is not set. Add it to your .env file.',
      FIXED_ISO,
      FIXED_ISO,
      'req-7',
    ]);
  });

  it('warns and resolves when the writer fails (best-effort, never rejects)', async () => {
    const warnings: string[] = [];
    const writer: D1RestWriter = {
      apply: async () => {
        throw new Error('D1 HTTP API rejected the batch: invalid token');
      },
    };
    const reporter = createIngestStatusReporter({
      requestId: 'req-5',
      writer,
      now: FIXED_NOW,
      warn: (message) => warnings.push(message),
    });

    await reporter.running('UC_test_channel');
    await reporter.complete({
      videos: 0,
      comments: 0,
      replies: 0,
      skippedVideos: 0,
      quotaUsed: 0,
      chatMessages: 0,
    });
    await reporter.failed('boom');

    assert.equal(warnings.length, 3);
    for (const warning of warnings) {
      assert.match(warning, /status update for ingest request req-5 failed/);
      assert.match(warning, /invalid token/);
    }
  });

  it('defaults the warning sink to stderr', async () => {
    const originalErr = process.stderr.write;
    const chunks: string[] = [];
    process.stderr.write = ((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const writer: D1RestWriter = {
        apply: async () => {
          throw new Error('network down');
        },
      };
      const reporter = createIngestStatusReporter({ requestId: 'req-6', writer, now: FIXED_NOW });

      await reporter.failed('boom');

      assert.match(chunks.join(''), /^\[WARN\] status update for ingest request req-6 failed/);
    } finally {
      process.stderr.write = originalErr;
    }
  });
});

describe('truncateStatusError', () => {
  it('keeps short messages unchanged', () => {
    assert.equal(truncateStatusError('boom'), 'boom');
    assert.equal(truncateStatusError(''), '');
  });

  it('slices longer messages at the cap', () => {
    const message = 'y'.repeat(STATUS_ERROR_MAX_CHARS + 1);
    assert.equal(truncateStatusError(message), 'y'.repeat(STATUS_ERROR_MAX_CHARS));
  });
});
