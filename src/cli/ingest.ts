/**
 * Ingest CLI — full orchestrator (#19 / T06).
 *
 * One-shot run: validate the API key, parse the channel argument, collect
 * the Catalog rows through the Ingest pipeline (`../ingest/pipeline.ts`:
 * resolve the channel, page its uploads, enrich videos, fetch top-level
 * comments, detect `TimeAnchor`s), and persist everything. Since R1 (#45)
 * the pipeline runs as stages into a buffering row sink
 * (`../ingest/stages.ts`). This file owns the CLI concerns: env, quota and
 * call logging, the write target, status reporting, and exit codes. Default target is the local SQLite catalog (one atomic
 * `Executor.batch`); `--remote` sends the same statements to the production D1
 * database over the D1 HTTP API instead (chunked, best-effort — ADR-0003).
 * `--report-status <requestId>` (remote-only) additionally advances the
 * `ingest_requests` row through `running → done/failed` for the web app's
 * status polling (ADR-0005). The reporter is built before the first validation
 * step, so a failure anywhere — including a bad API key or channel input —
 * marks the row `failed`; reporting is best-effort and never aborts the ingest
 * itself.
 *
 * Sources of decisions:
 *  - `docs/spec/v1.md` §5 (ordered steps + error matrix + logging).
 *  - build spec #12 (module map, single seam, one transaction).
 *  - `docs/adr/0005-fe-triggered-ingest-on-github-actions.md` (status row).
 *
 * Seams for tests:
 *  - `transport` — the same `(url, init?) => Promise<Response>` seam the
 *    YouTube client already exposes.
 *  - `quota` — inject a `QuotaCounter` (defaults to a fresh 9500-unit budget).
 *  - `writer` — inject a `D1RestWriter` for `--remote` (defaults to the
 *    env-configured HTTP writer).
 *  - `statusWriter` — inject a `D1RestWriter` for `--report-status` updates.
 *  - `now` — override the clock so `fetched_at` values are deterministic.
 */
import 'dotenv/config';
import { API_KEY_FAILURE_MESSAGES, validateApiKey } from '../yt/api-key.ts';
import { parseChannelInput, UsageError } from '../yt/parse-channel.ts';
import { ApiError, createYouTubeClient } from '../yt/client.ts';
import type { Transport } from '../yt/client.ts';
import { QuotaCounter, QuotaExceededError } from '../yt/quota.ts';
import { openCatalog, type SqliteExecutor } from '../db/sqlite.ts';
import { createD1RestWriter, type D1RestWriter } from '../db/d1-http.ts';
import { ingestStatements } from '../db/queries.ts';
import { ChannelNotFoundError, defaultIngestStages, isQuotaExceeded } from '../ingest/pipeline.ts';
import { createBufferingSink, runIngestStages, type PipelineContext } from '../ingest/stages.ts';
import { createIngestStatusReporter, type IngestStatusReporter } from './status.ts';
import type { ChannelInput } from '../shared/types.ts';

const DEFAULT_DB_PATH = './catalog.sqlite';
const DEFAULT_API_KEY_ENV = 'YOUTUBE_API_KEY';
/** Environment variables required by `--remote` (D1 HTTP API, ADR-0003). */
const REMOTE_ENV_VARS = [
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'D1_DATABASE_ID',
] as const;

/** Names among {@link REMOTE_ENV_VARS} that are unset or empty. */
function missingRemoteEnvVars(): string[] {
  return REMOTE_ENV_VARS.filter((name) => (process.env[name] ?? '') === '');
}

/** Spec §5 — printed on stderr when the API reports quota exhaustion. */
const QUOTA_MESSAGE = '[ERROR] quota exhausted, resets at midnight Pacific Time';
/** Printed once when the running quota total crosses 8000 units. */
const QUOTA_WARN = '[WARN] quota ~8000/10000 units used';

/** Pipeline tallies reported in the summary line. */
interface IngestSummary {
  channels: number;
  videos: number;
  comments: number;
  anchors: number;
}

// ---------------------------------------------------------------------------
// Error reporting
// ---------------------------------------------------------------------------

/**
 * Map a thrown error to the spec §5 exit code, printing the right stderr
 * message. Per-video `commentsDisabled` / `videoNotFound` never reach here —
 * the per-video loop handles those inline.
 */
function reportIngestError(error: unknown): number {
  if (error instanceof QuotaExceededError || isQuotaExceeded(error)) {
    process.stderr.write(`${QUOTA_MESSAGE}\n`);
    return 2;
  }
  if (error instanceof ApiError) {
    process.stderr.write(`Google error envelope: ${JSON.stringify(error.googleError)}\n`);
    return 1;
  }
  if (error instanceof ChannelNotFoundError) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  return 1;
}

// ---------------------------------------------------------------------------
// Programmatic entry
// ---------------------------------------------------------------------------

/** Programmatic entry — used by tests and by the CLI shim below. */
export async function runIngest(
  args: {
    channel?: string;
    verbose?: boolean;
    /** Write to remote D1 over the HTTP API instead of the local catalog. */
    remote?: boolean;
    /**
     * `ingest_requests.id` to report pipeline status to. Requires `remote`
     * (ADR-0005); reporting is best-effort and never aborts the ingest.
     */
    reportStatus?: string;
    /**
     * Injectable D1 writer for status updates — used by tests; falls back to
     * `writer` when the D1 env vars are absent.
     */
    statusWriter?: D1RestWriter;
    dbPath?: string;
    /** Injectable transport — used by tests. Defaults to `globalThis.fetch`. */
    transport?: Transport;
    /** Injectable quota counter — used by tests. Defaults to `new QuotaCounter()`. */
    quota?: QuotaCounter;
    /** Injectable D1 writer — used by tests. Defaults to the env-configured HTTP writer. */
    writer?: D1RestWriter;
    /** Override NOW (ms) — used by tests for deterministic `fetchedAt`. */
    now?: () => Date;
  } = {},
): Promise<number> {
  const startTimeMs = Date.now();
  const verbose = args.verbose ?? false;
  const remote = args.remote ?? false;
  const dbPath = args.dbPath ?? DEFAULT_DB_PATH;
  const now = args.now ?? ((): Date => new Date());
  const quota = args.quota ?? new QuotaCounter();

  const log = (message: string): void => {
    process.stdout.write(`${message}\n`);
  };
  const error = (message: string): void => {
    process.stderr.write(`${message}\n`);
  };

  // `--report-status` is remote-only: the local catalog has no
  // `ingest_requests` table and no token to reach the hosted one.
  if (args.reportStatus !== undefined && !remote) {
    error('Error: --report-status requires --remote.');
    return 1;
  }
  if (args.reportStatus === '') {
    error('Error: --report-status requires a <requestId> value.');
    return 1;
  }

  // Status reporting is best-effort and constructed BEFORE any validation
  // step, so a pre-start failure (bad API key, bad channel input, …) can still
  // mark the request `failed` (ADR-0005). The D1 credentials are independent
  // of the YouTube API key. When neither an injected writer nor the D1 env
  // vars are available we cannot reach D1: warn and let the run proceed
  // (`--remote`'s own env check below still applies).
  let statusReporter: IngestStatusReporter | undefined;
  if (args.reportStatus !== undefined) {
    const statusWriter = args.statusWriter ?? args.writer;
    const missing = missingRemoteEnvVars();
    if (statusWriter !== undefined || missing.length === 0) {
      statusReporter = createIngestStatusReporter({
        requestId: args.reportStatus,
        writer:
          statusWriter ??
          createD1RestWriter({
            accountId: process.env['CLOUDFLARE_ACCOUNT_ID'] ?? '',
            databaseId: process.env['D1_DATABASE_ID'] ?? '',
            token: process.env['CLOUDFLARE_API_TOKEN'] ?? '',
          }),
        now,
      });
    } else {
      error(`[WARN] --report-status disabled: missing ${missing.join(', ')}.`);
    }
  }

  /** Best-effort terminal `failed` report; returns the given exit code. */
  async function fail(message: string, code: number): Promise<number> {
    await statusReporter?.failed(message);
    return code;
  }

  /** Print the spec error line, report `failed` best-effort, return the code. */
  async function handleFailure(err: unknown): Promise<number> {
    const code = reportIngestError(err);
    await statusReporter?.failed(err instanceof Error ? err.message : String(err));
    return code;
  }

  // 1. Validate the API key — cheapest possible fail, before any I/O.
  log('[1/8] Validating API key...');
  const key = process.env[DEFAULT_API_KEY_ENV];
  const keyResult = validateApiKey(key);
  if (!keyResult.ok) {
    const message = API_KEY_FAILURE_MESSAGES[keyResult.reason];
    error(message);
    return await fail(message, 1);
  }
  // `keyResult.ok` narrows `key` to a string only loosely; assert it here.
  const apiKey = key as string;

  // 2. Parse the channel argument.
  log('[2/8] Parsing input...');
  let channelInput: ChannelInput;
  try {
    if (args.channel === undefined || args.channel === '') {
      throw new UsageError('missing <channel> argument.');
    }
    channelInput = parseChannelInput(args.channel);
  } catch (err) {
    if (err instanceof UsageError) {
      const message = `Error: ${err.message}`;
      error(message);
      return await fail(message, 1);
    }
    return await handleFailure(err);
  }

  // 3. Prepare the write target: the local SQLite catalog by default, or the
  // remote D1 database over the HTTP API with `--remote`.
  let db: SqliteExecutor | undefined;
  let writer: D1RestWriter | undefined;
  if (remote) {
    log('[3/8] Configuring remote D1 write...');
    const missing = missingRemoteEnvVars();
    if (missing.length > 0) {
      const message = `Error: --remote requires ${missing.join(', ')}. Check the values in .env.`;
      error(message);
      return await fail(message, 1);
    }
    writer =
      args.writer ??
      createD1RestWriter({
        accountId: process.env['CLOUDFLARE_ACCOUNT_ID'] ?? '',
        databaseId: process.env['D1_DATABASE_ID'] ?? '',
        token: process.env['CLOUDFLARE_API_TOKEN'] ?? '',
      });
  } else {
    log(`[3/8] Opening catalog database at ${dbPath}...`);
    try {
      db = await openCatalog(dbPath);
    } catch (err) {
      return await handleFailure(err);
    }
  }

  const client = createYouTubeClient({
    apiKey,
    ...(args.transport !== undefined ? { transport: args.transport } : {}),
  });

  let warnedQuota = false;

  /** Run one client call, log it under `--verbose`, and bill one quota unit. */
  async function tracked<T>(label: string, call: () => Promise<T>): Promise<T> {
    if (verbose) log(`[call] ${label}`);
    const result = await call();
    quota.consume(1);
    if (!warnedQuota && quota.total >= 8000) {
      warnedQuota = true;
      log(QUOTA_WARN);
    }
    return result;
  }

  /**
   * Steps 4–10: run the default Ingest stages into a buffering row sink,
   * then write its rows. Every write is deferred to step 10 (one atomic
   * batch locally, chunked best-effort calls remotely). Throws on any
   * failure.
   */
  async function runPipeline(): Promise<IngestSummary> {
    const ctx: PipelineContext = {
      client,
      call: tracked,
      log,
      verbose,
      fetchedAt: now().toISOString(),
    };
    // `running` is instrumentation only (ADR-0005): the run is live and the
    // channel id is resolved. Best-effort — a reporting failure never aborts.
    const buffer = createBufferingSink();
    await runIngestStages(ctx, channelInput, defaultIngestStages, {
      emit: async (batch) => {
        await buffer.emit(batch);
        if ('channel' in batch) await statusReporter?.running(batch.channel.id);
      },
    });
    const rows = buffer.rows();
    const { videos, comments, anchors } = rows;

    // 10. Persist the whole run: channel → videos → comments → anchors (FK
    // order). Locally this is one atomic batch (ADR-0001 all-or-nothing);
    // remotely it is chunked, best-effort D1 HTTP calls (no documented
    // atomicity) that rely on the idempotent upserts + re-run for repair.
    const statements = ingestStatements(rows);
    if (writer !== undefined) {
      await writer.apply(statements);
    } else if (db !== undefined) {
      await db.batch(statements);
    }

    // Instrumentation only: final counts land with the terminal `done`
    // update, batched into one writer call. Best-effort, never throws.
    if (statusReporter !== undefined) {
      await statusReporter.complete({ videos: videos.length, comments: comments.length });
    }

    return {
      channels: 1,
      videos: videos.length,
      comments: comments.length,
      anchors: anchors.length,
    };
  }

  // The whole run is one write step: locally nothing lands until the atomic
  // batch succeeds (any throw leaves the previous catalog untouched); remotely
  // a failed chunk leaves earlier idempotent upserts in place — re-run repairs.
  try {
    const summary = await runPipeline();

    // 12. Summary.
    const durationSeconds = (Date.now() - startTimeMs) / 1000;
    log('Done.');
    log(
      `channels=${summary.channels} videos=${summary.videos} comments=${summary.comments} ` +
        `anchors=${summary.anchors} duration=${durationSeconds.toFixed(1)}s quota=${quota.total}`,
    );
    return 0;
  } catch (err) {
    return await handleFailure(err);
  } finally {
    db?.close();
  }
}

/** Parsed CLI arguments for the `pnpm ingest` shim. */
export interface IngestCliArgs {
  channel?: string;
  verbose: boolean;
  remote: boolean;
  reportStatus?: string;
  /** Set when the flags are invalid; the shim prints `Error: <error>` and exits 1. */
  error?: string;
}

/**
 * Parse `pnpm ingest` argv (without `node`/script). Flags may appear in any
 * order; the first non-flag argument is the channel. `--report-status` takes
 * its value either as the next argument or inline (`--report-status=<id>`).
 */
export function parseIngestArgs(argv: string[]): IngestCliArgs {
  const parsed: IngestCliArgs = { verbose: false, remote: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--verbose') {
      parsed.verbose = true;
    } else if (arg === '--remote') {
      parsed.remote = true;
    } else if (arg === '--report-status' || arg.startsWith('--report-status=')) {
      const inlineValue = arg.startsWith('--report-status=')
        ? arg.slice('--report-status='.length)
        : undefined;
      const value = inlineValue ?? argv[index + 1];
      if (
        value === undefined ||
        value === '' ||
        (inlineValue === undefined && value.startsWith('--'))
      ) {
        return { ...parsed, error: '--report-status requires a <requestId> value.' };
      }
      parsed.reportStatus = value;
      if (inlineValue === undefined) index += 1;
    } else if (!arg.startsWith('--') && parsed.channel === undefined) {
      parsed.channel = arg;
    }
  }
  if (parsed.reportStatus !== undefined && !parsed.remote) {
    return { ...parsed, error: '--report-status requires --remote.' };
  }
  return parsed;
}

// CLI shim — only runs when invoked directly (`tsx src/cli/ingest.ts`).
const isCli =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('ingest.ts') === true;
if (isCli) {
  const parsed = parseIngestArgs(process.argv.slice(2));
  if (parsed.error !== undefined) {
    process.stderr.write(`Error: ${parsed.error}\n`);
    process.exit(1);
  }
  runIngest({
    ...(parsed.channel !== undefined ? { channel: parsed.channel } : {}),
    verbose: parsed.verbose,
    remote: parsed.remote,
    ...(parsed.reportStatus !== undefined ? { reportStatus: parsed.reportStatus } : {}),
  }).then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`Error: ${(err as Error).message}\n`);
      process.exit(1);
    },
  );
}
