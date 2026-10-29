/**
 * IngestRequest status reporting for `pnpm ingest --remote --report-status`.
 *
 * The web app creates the `ingest_requests` row before dispatching the GitHub
 * Actions run (ADR-0005); the runner (this CLI) advances it through
 * `queued → running → done/failed`, reporting the resolved channel id, final
 * counts, and errors. Every update stamps `updated_at`; the terminal
 * `done`/`failed` updates also stamp `finished_at` (migration 0002). Updates
 * go through the same `D1RestWriter` seam `--remote` uses for catalog writes,
 * so they inherit the chunked/best-effort HTTP shape, the same token/env
 * vars, and the same global D1 REST request budget.
 *
 * Reporting is strictly best-effort: a failed update is logged as a warning
 * and never aborts the ingest (ADR-0005: repair is re-running the ingest).
 *
 * F3a (#49): `done` also reports `replies_written`, `skipped_videos` and
 * `quota_used` (migration 0003), and `failed` reports `quota_used` when the
 * caller knows it.
 */
import type { D1RestWriter } from '../db/d1-http.ts';
import type { Statement } from '../db/executor.ts';

/** `error` text is truncated to this many characters before storage. */
export const STATUS_ERROR_MAX_CHARS = 500;

/** Final row counts reported with the terminal `done` update. */
export interface IngestStatusCounts {
  /** VideoRecords written → `videos_written`. */
  videos: number;
  /**
   * Top-level CommentRecords written → `comments_written`. Replies are NOT
   * included: they are counted apart in {@link IngestStatusCounts.replies},
   * so the two columns add up to every CommentRecord of the run.
   */
  comments: number;
  /** Replies written → `replies_written`. */
  replies: number;
  /** Videos skipped and not stored (upcoming Broadcasts) → `skipped_videos`. */
  skippedVideos: number;
  /** Quota units the run spent → `quota_used`. */
  quotaUsed: number;
}

/** Progress known when a run fails, reported with the terminal `failed` update. */
export interface IngestFailureProgress {
  /** Quota units spent before the failure → `quota_used`. */
  quotaUsed: number;
}

/** Best-effort lifecycle updates for one `ingest_requests` row. */
export interface IngestStatusReporter {
  /** `running` + the resolved YouTube channel id. */
  running(channelId: string): Promise<void>;
  /**
   * `done` + final `videos_written` / `comments_written` (top-level only) /
   * `replies_written` / `skipped_videos` / `quota_used`.
   */
  complete(counts: IngestStatusCounts): Promise<void>;
  /**
   * `failed` + a truncated error message, plus `quota_used` when `progress`
   * is given (pre-start failures leave the column at its default).
   */
  failed(error: string, progress?: IngestFailureProgress): Promise<void>;
}

/** Options for {@link createIngestStatusReporter}. */
export interface IngestStatusReporterOptions {
  /** `ingest_requests.id` assigned by the trigger route. */
  requestId: string;
  /** The `--remote` writer (same D1 database/token as the catalog writes). */
  writer: D1RestWriter;
  /** Injectable clock for `updated_at`; defaults to `new Date()`. */
  now?: () => Date;
  /** Warning sink for best-effort failures; defaults to stderr. */
  warn?: (message: string) => void;
}

/** Keep the stored error readable — D1 rows should not carry stack dumps. */
export function truncateStatusError(message: string): string {
  return message.length <= STATUS_ERROR_MAX_CHARS
    ? message
    : message.slice(0, STATUS_ERROR_MAX_CHARS);
}

/**
 * Create a reporter bound to one request id and one D1 writer.
 *
 * Every method resolves even when the write fails: the failure is surfaced as
 * one `[WARN]` line through `warn` and the ingest continues.
 */
export function createIngestStatusReporter(
  options: IngestStatusReporterOptions,
): IngestStatusReporter {
  const {
    requestId,
    writer,
    now = (): Date => new Date(),
    warn = (message: string): void => {
      process.stderr.write(`[WARN] ${message}\n`);
    },
  } = options;

  /** Best-effort: never rejects; a failure becomes one warning line. */
  async function report(statements: Statement[]): Promise<void> {
    try {
      await writer.apply(statements);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warn(`status update for ingest request ${requestId} failed: ${message}`);
    }
  }

  return {
    async running(channelId: string): Promise<void> {
      await report([
        {
          sql: `
            UPDATE ingest_requests
            SET status = 'running', channel_id = ?, updated_at = ?
            WHERE id = ?
          `,
          params: [channelId, now().toISOString(), requestId],
        },
      ]);
    },

    async complete(counts: IngestStatusCounts): Promise<void> {
      const finishedAt = now().toISOString();
      await report([
        {
          sql: `
            UPDATE ingest_requests
            SET status = 'done', videos_written = ?,
                comments_written = ?, replies_written = ?, skipped_videos = ?, quota_used = ?,
                updated_at = ?, finished_at = ?
            WHERE id = ?
          `,
          params: [
            counts.videos,
            counts.comments,
            counts.replies,
            counts.skippedVideos,
            counts.quotaUsed,
            finishedAt,
            finishedAt,
            requestId,
          ],
        },
      ]);
    },

    async failed(error: string, progress?: IngestFailureProgress): Promise<void> {
      const finishedAt = now().toISOString();
      const params: unknown[] = [truncateStatusError(error), finishedAt, finishedAt];
      if (progress !== undefined) params.push(progress.quotaUsed);
      params.push(requestId);
      await report([
        {
          sql: `
            UPDATE ingest_requests
            SET status = 'failed', error = ?, updated_at = ?, finished_at = ?${progress !== undefined ? ', quota_used = ?' : ''}
            WHERE id = ?
          `,
          params,
        },
      ]);
    },
  };
}
