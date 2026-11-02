/**
 * Measure the two hypotheses ADR-0012 (proposed) rests on, before accepting it.
 *
 *  1. Sample quality: for the newest `--max-videos` VideoRecords of a Channel,
 *     fetch a CommentSample (one `commentThreads.list?videoId=…&order=relevance`
 *     page, embedded Replies only) and, right after it, the full comments of
 *     the same VideoRecord (every `order=time` page plus every Reply page, the
 *     data today's Ingest stores). Compare timestamped CommentRecords,
 *     TimeAnchors and "Key moments" (`./measure/compare.ts`).
 *  2. D1 cost: write the full rows into a throwaway LOCAL D1 (workerd, via
 *     `wrangler d1 migrations apply --local` into a temporary directory) and
 *     read `meta.rows_written` per statement, first as new rows and then as a
 *     refresh of the same rows (`./measure/rows-written.ts`). Never touches
 *     the production D1: nothing here passes `--remote`.
 *
 * Usage:
 *   pnpm exec tsx scripts/measure-comment-samples.ts <channel>
 *     [--max-videos 30] [--sample-size 100] [--budget 2000]
 *     [--skip-rows] [--out report.json]
 *
 * Reads `YOUTUBE_API_KEY` from the environment or `.env` and never prints it.
 * Spends quota on that key's project: the run prints an estimate first and
 * stops before any comment call when the estimate exceeds `--budget`.
 */
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createYouTubeClient, type CommentThread } from '../src/yt/client.ts';
import { validateApiKey } from '../src/yt/api-key.ts';
import { parseChannelInput } from '../src/yt/parse-channel.ts';
import { QuotaCounter, QuotaExceededError } from '../src/yt/quota.ts';
import {
  apiErrorReason,
  enrichVideos,
  fetchReplies,
  isQuotaExceeded,
  listUploadIds,
  resolveChannel,
  toCommentRows,
  type RawComment,
} from '../src/ingest/pipeline.ts';
import type { PipelineContext } from '../src/ingest/stages.ts';
import { ingestStatements } from '../src/db/ingest-writes.ts';
import type { CommentRecord, TimeAnchor, VideoRecord } from '../src/shared/types.ts';
import { compareSamples, type ComparisonReport } from './measure/compare.ts';
import { measureRowsWritten, type RowsWrittenTally } from './measure/rows-written.ts';

/** D1's free plan: rows written per day (ADR-0002, ADR-0005). */
const D1_FREE_ROWS_PER_DAY = 100_000;

interface Flags {
  channel: string;
  maxVideos: number;
  sampleSize: number;
  budget: number;
  skipRows: boolean;
  out: string | undefined;
}

function positiveInt(name: string, value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} needs a positive integer`);
  return parsed;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {
    channel: '',
    maxVideos: 30,
    sampleSize: 100,
    budget: 2000,
    skipRows: false,
    out: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--max-videos') flags.maxVideos = positiveInt(arg, argv[++i]);
    else if (arg === '--sample-size') flags.sampleSize = positiveInt(arg, argv[++i]);
    else if (arg === '--budget') flags.budget = positiveInt(arg, argv[++i]);
    else if (arg === '--skip-rows') flags.skipRows = true;
    else if (arg === '--out') flags.out = argv[++i];
    else if (arg.startsWith('--')) throw new Error(`unknown flag ${arg}`);
    else flags.channel = arg;
  }
  if (flags.channel === '') throw new Error('usage: measure-comment-samples.ts <channel> [flags]');
  if (flags.sampleSize > 100) throw new Error('--sample-size is at most 100 (one API page)');
  return flags;
}

const pct = (value: number | null): string =>
  value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function threadToRaw(videoId: string, thread: CommentThread, replies: RawComment['comment'][]) {
  const topLevel = thread.snippet.topLevelComment;
  return [
    { videoId, comment: topLevel },
    ...replies.map((reply) => ({ videoId, comment: reply, parentId: topLevel.id })),
  ] satisfies RawComment[];
}

async function fetchSample(
  ctx: PipelineContext,
  videoId: string,
  sampleSize: number,
): Promise<RawComment[]> {
  const page = await ctx.call(`sample ${videoId}`, () =>
    ctx.client.listCommentThreads({ videoId, maxResults: sampleSize, order: 'relevance' }),
  );
  return page.items.flatMap((thread) =>
    threadToRaw(videoId, thread, thread.replies?.comments ?? []),
  );
}

async function fetchFull(ctx: PipelineContext, videoId: string): Promise<RawComment[]> {
  const raw: RawComment[] = [];
  const seen = new Set<string>();
  let pageToken: string | undefined;
  for (;;) {
    const page = await ctx.call(`full ${videoId}`, () =>
      ctx.client.listCommentThreads({
        videoId,
        maxResults: 100,
        order: 'time',
        ...(pageToken !== undefined ? { pageToken } : {}),
      }),
    );
    for (const thread of page.items) {
      if (seen.has(thread.snippet.topLevelComment.id)) continue;
      seen.add(thread.snippet.topLevelComment.id);
      raw.push(...threadToRaw(videoId, thread, await fetchReplies(ctx, thread)));
    }
    pageToken = page.nextPageToken;
    if (pageToken === undefined) break;
  }
  return raw;
}

/** Comment-call estimate: sample + full thread pages; Reply pages come on top. */
function estimateUnits(videos: VideoRecord[]): number {
  return videos.reduce(
    (units, video) => units + 1 + Math.max(1, Math.ceil(video.commentCount / 100)),
    0,
  );
}

async function measureD1(rows: {
  channel: Parameters<typeof ingestStatements>[0]['channel'];
  videos: VideoRecord[];
  comments: CommentRecord[];
  anchors: TimeAnchor[];
}): Promise<{ insert: RowsWrittenTally; refresh: RowsWrittenTally }> {
  const stateDir = mkdtempSync(join(tmpdir(), 'ytb-measure-d1-'));
  try {
    log(`[d1] applying migrations to a throwaway local D1 in ${stateDir}`);
    execFileSync(
      'pnpm',
      [
        'exec',
        'wrangler',
        'd1',
        'migrations',
        'apply',
        'ytb-index',
        '--local',
        '--persist-to',
        stateDir,
      ],
      { stdio: 'ignore', env: { ...process.env, CI: '1' } },
    );
    const { getPlatformProxy } = await import('wrangler');
    const proxy = await getPlatformProxy<{ ytb_index: Parameters<typeof measureRowsWritten>[0] }>({
      persist: { path: join(stateDir, 'v3') },
    });
    try {
      const binding = proxy.env.ytb_index;
      const insert = await measureRowsWritten(binding, ingestStatements(rows));
      // A refresh (ADR-0001) re-writes the same rows with a new fetched_at.
      const later = new Date(Date.parse(rows.channel.fetchedAt) + 86_400_000).toISOString();
      const refreshed = {
        channel: { ...rows.channel, fetchedAt: later },
        videos: rows.videos.map((video) => ({ ...video, fetchedAt: later })),
        comments: rows.comments.map((comment) => ({ ...comment, fetchedAt: later })),
        anchors: rows.anchors,
      };
      const refresh = await measureRowsWritten(binding, ingestStatements(refreshed));
      return { insert, refresh };
    } finally {
      await proxy.dispose();
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

function perRecord(tally: RowsWrittenTally, table: string): number | null {
  const entry = tally[table];
  return entry === undefined || entry.statements === 0
    ? null
    : entry.rowsWritten / entry.statements;
}

function printComparison(report: ComparisonReport, sampleSize: number): void {
  const s = report.summary;
  log('');
  log(`== 1. CommentSample (top ${sampleSize} by relevance) vs full comments ==`);
  log(`videos compared:            ${s.videos} (${s.videosWithAnchors} with TimeAnchors)`);
  log(`CommentRecords:             sample ${s.sampleComments} / full ${s.fullComments}`);
  log(`timestamped CommentRecords: sample ${s.sampleTimestamped} / full ${s.fullTimestamped}`);
  log(`timestamped recall:         ${pct(s.timestampedRecall)}`);
  log(`TimeAnchor recall:          ${pct(s.anchorRecall)}`);
  log(`Key moments found (exact):  ${pct(s.meanKeyMomentsExact)} (mean per video)`);
  log(`Key moments found (±10 s):  ${pct(s.meanKeyMomentsTolerant)}`);
  log(`top moment identical:       ${pct(s.topMomentMatchRate)}`);
  log(`videos losing every anchor: ${s.videosMissingAllAnchors.length}`);
  log('');
  log(
    'per video (full comments desc): id  full/sample comments  ts recall  moments exact/±10s  top',
  );
  const rows = [...report.perVideo].sort((a, b) => b.fullComments - a.fullComments);
  for (const v of rows) {
    log(
      `  ${v.videoId}  ${v.fullComments}/${v.sampleComments}  ${pct(v.timestampedRecall)}  ` +
        `${pct(v.keyMomentsExact)}/${pct(v.keyMomentsTolerant)}  ${v.topMomentMatch ?? 'n/a'}`,
    );
  }
}

function printD1(
  d1: { insert: RowsWrittenTally; refresh: RowsWrittenTally },
  rows: { comments: CommentRecord[]; anchors: TimeAnchor[] },
  channelVideoCount: number,
  sampleCommentsPerVideo: number,
): void {
  log('');
  log('== 2. D1 rows written (local workerd D1, same accounting as production) ==');
  for (const [label, tally] of [
    ['new rows', d1.insert],
    ['refresh', d1.refresh],
  ] as const) {
    for (const [table, entry] of Object.entries(tally)) {
      log(
        `${label.padEnd(8)}  ${table.padEnd(13)} ${entry.statements} statements, ` +
          `${entry.rowsWritten} rows written (${(entry.rowsWritten / entry.statements).toFixed(2)} each)`,
      );
    }
  }
  const comments = rows.comments.length;
  if (comments === 0) return;
  const anchorsPerComment = rows.anchors.length / comments;
  for (const [label, tally] of [
    ['new', d1.insert],
    ['refresh', d1.refresh],
  ] as const) {
    const perComment =
      (perRecord(tally, 'comments') ?? 0) +
      anchorsPerComment * (perRecord(tally, 'time_anchors') ?? 0);
    const perDay = Math.floor(D1_FREE_ROWS_PER_DAY / perComment);
    const channelRows = channelVideoCount * sampleCommentsPerVideo * perComment;
    log(
      `${label}: ${perComment.toFixed(2)} rows per CommentRecord incl. its anchors -> ` +
        `${perDay} CommentRecords/day on the free plan; sampling all ${channelVideoCount} videos ` +
        `≈ ${Math.round(channelRows)} rows ≈ ${(channelRows / D1_FREE_ROWS_PER_DAY).toFixed(1)} free days`,
    );
  }
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const apiKey = process.env['YOUTUBE_API_KEY'];
  if (!validateApiKey(apiKey).ok || apiKey === undefined) {
    throw new Error('YOUTUBE_API_KEY is missing or malformed (set it in the environment or .env)');
  }
  const quota = new QuotaCounter(flags.budget);
  const ctx: PipelineContext = {
    client: createYouTubeClient({ apiKey }),
    call: async (_label, run, units = 1) => {
      quota.consume(units);
      return run();
    },
    log,
    verbose: false,
    fetchedAt: new Date().toISOString(),
  };

  const channel = await resolveChannel(ctx, parseChannelInput(flags.channel));
  log(`channel: ${channel.title} (${channel.id})`);
  const allIds = await listUploadIds(ctx, channel.uploadsPlaylistId);
  const picked = allIds.slice(0, flags.maxVideos);
  const { videos } = await enrichVideos(ctx, picked, channel.id);
  const withComments = videos.filter((video) => video.commentCount > 0);
  const estimate = estimateUnits(withComments);
  log(
    `uploads: ${allIds.length}; measuring the newest ${videos.length} ` +
      `(${withComments.length} with comments); quota so far ${quota.total}`,
  );
  log(`estimated comment calls: ~${estimate} units, plus one per thread with >5 Replies`);
  if (quota.total + estimate > flags.budget) {
    throw new Error(
      `estimate exceeds --budget ${flags.budget}; lower --max-videos or raise --budget`,
    );
  }

  const sampleRaw: RawComment[] = [];
  const fullRaw: RawComment[] = [];
  const compared: string[] = [];
  for (const [index, video] of withComments.entries()) {
    try {
      // Sample first, full right after, so both sides see the same comments.
      // A VideoRecord counts only when both sides finished.
      const sampled = await fetchSample(ctx, video.id, flags.sampleSize);
      const fetched = await fetchFull(ctx, video.id);
      sampleRaw.push(...sampled);
      fullRaw.push(...fetched);
      compared.push(video.id);
    } catch (err) {
      if (err instanceof QuotaExceededError || isQuotaExceeded(err)) {
        log(`[stop] quota reached at video ${index + 1}; comparing the ${compared.length} done`);
        break;
      }
      if (apiErrorReason(err) !== 'commentsDisabled') throw err;
      log(`[skip] ${video.id}: commentsDisabled`);
    }
    log(`[${index + 1}/${withComments.length}] ${video.id} done, quota ${quota.total}`);
  }

  const sample = toCommentRows(sampleRaw, channel.id, ctx.fetchedAt);
  const full = toCommentRows(fullRaw, channel.id, ctx.fetchedAt);
  const comparison = compareSamples(compared, full, sample);
  printComparison(comparison, flags.sampleSize);

  let d1: { insert: RowsWrittenTally; refresh: RowsWrittenTally } | undefined;
  if (!flags.skipRows) {
    d1 = await measureD1({ channel, videos, comments: full.comments, anchors: full.anchors });
    const sampleCommentsPerVideo =
      compared.length === 0 ? 0 : sample.comments.length / compared.length;
    printD1(d1, full, allIds.length, sampleCommentsPerVideo);
  }

  log('');
  log(`quota used: ${quota.total} units`);
  if (flags.out !== undefined) {
    writeFileSync(
      flags.out,
      JSON.stringify(
        {
          channel: { id: channel.id, title: channel.title, uploads: allIds.length },
          sampleSize: flags.sampleSize,
          quotaUsed: quota.total,
          comparison,
          d1,
        },
        null,
        2,
      ),
    );
    log(`report written to ${flags.out}`);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
