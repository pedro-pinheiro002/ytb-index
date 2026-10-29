/**
 * Live-chat capture stage (`src/ingest/live-chat`), from F3b (#52) and
 * ADR-0009 (official API, on-air Broadcasts only, opt-in and budgeted).
 *
 * For each stored VideoRecord that is an on-air Broadcast with an
 * `activeLiveChatId` (handed over by the enrich stage in
 * `IngestState.liveChatIds`), poll `liveChatMessages.list`, emit that poll's
 * LiveChatMessages into the run's sink, wait the server's
 * `pollingIntervalMillis` through the injected `sleep`, and repeat. Capture
 * ends at the first of: `offlineAt` on a page (after storing it), a
 * live-chat-ended error, the chat budget (units spent by this stage's polls),
 * or the wall-clock cap measured by the injected `now`. The run's
 * `QuotaCounter` still applies through `call`: exceeding it throws as for any
 * other call, and rows already emitted stay with the sink.
 *
 * Only `textMessageEvent`s and Super Chats with a non-empty `userComment` are
 * kept ({@link toLiveChatMessage}); everything else is skipped. The stage
 * never writes: the CLI gives it a sink that flushes each emission.
 */
import { isLiveChatEndedError, QUOTA_COST } from '../yt/client.ts';
import type { LiveChatMessageResource } from '../yt/client.ts';
import { normalizeSearchText } from '../db/search-text.ts';
import { requireState, type IngestRun, type IngestStage } from './stages.ts';
import type { LiveChatMessage, VideoRecord } from '../shared/types.ts';

/** Default chat budget in quota units (ADR-0009). */
export const DEFAULT_LIVE_CHAT_BUDGET_UNITS = 3000;

/** Default wall-clock cap: below the 6 h Actions job limit (ADR-0009). */
export const LIVE_CHAT_MAX_DURATION_MS = 5 * 60 * 60 * 1000;

/** Wait used when a page carries no usable `pollingIntervalMillis`. */
const FALLBACK_POLL_INTERVAL_MS = 5000;

/** Seams and limits of {@link createLiveChatStage}. */
export interface LiveChatStageOptions {
  /** Most quota units this stage's polls may spend in one run. */
  budgetUnits: number;
  /** Wait between polls; tests inject a fake that advances `now`. */
  sleep: (ms: number) => Promise<void>;
  /** The run's clock; the wall-clock cap is measured with it. */
  now: () => Date;
  /** Wall-clock cap from the stage's start; defaults to {@link LIVE_CHAT_MAX_DURATION_MS}. */
  maxDurationMs?: number;
}

/**
 * Map one `liveChatMessages.list` item of `video` to a LiveChatMessage, or
 * `undefined` when it is not stored: only text messages (text from
 * `textMessageDetails.messageText`, else `displayMessage`) and Super Chats
 * with a non-empty `userComment`. `offsetSeconds` is
 * `max(0, floor((publishedAt − actualStartTime) / 1000))`, 0 when either time
 * is unknown. Pure.
 */
export function toLiveChatMessage(
  item: LiveChatMessageResource,
  video: VideoRecord,
  fetchedAt: string,
): LiveChatMessage | undefined {
  const text = messageText(item);
  if (text === undefined) return undefined;
  return {
    id: item.id,
    videoId: video.id,
    channelId: video.channelId,
    author: item.authorDetails.displayName,
    authorChannelId: item.authorDetails.channelId,
    text,
    publishedAt: item.snippet.publishedAt,
    offsetSeconds: offsetSeconds(item.snippet.publishedAt, video.actualStartTime ?? null),
    searchText: normalizeSearchText(text),
    fetchedAt,
  };
}

/** The stored text of a chat item, or `undefined` for a skipped event type. */
function messageText(item: LiveChatMessageResource): string | undefined {
  const { snippet } = item;
  let text: string | undefined;
  if (snippet.type === 'textMessageEvent') {
    text = snippet.textMessageDetails?.messageText ?? snippet.displayMessage;
  } else if (snippet.type === 'superChatEvent') {
    text = snippet.superChatDetails?.userComment;
  }
  return text !== undefined && text.trim() !== '' ? text : undefined;
}

function offsetSeconds(publishedAt: string, actualStartTime: string | null): number {
  const delta = Date.parse(publishedAt) - Date.parse(actualStartTime ?? '');
  return Number.isFinite(delta) ? Math.max(0, Math.floor(delta / 1000)) : 0;
}

/** Shared limits of one stage run, across every on-air Broadcast. */
interface CaptureLimits {
  readonly options: LiveChatStageOptions;
  readonly deadlineMs: number;
  /** Units spent by this stage's polls so far. */
  unitsUsed: number;
}

/**
 * Poll one Broadcast's chat until it ends or a limit is hit. Returns `true`
 * when a run-wide limit (budget, wall clock) stopped it, so later Broadcasts
 * are not polled either.
 */
async function captureBroadcast(
  run: IngestRun,
  video: VideoRecord,
  liveChatId: string,
  limits: CaptureLimits,
): Promise<boolean> {
  const { options } = limits;
  const cost = QUOTA_COST.listLiveChatMessages;
  let pageToken: string | undefined;
  let polls = 0;
  let messages = 0;
  let units = 0;
  let stoppedByLimit = false;
  for (;;) {
    if (options.now().getTime() >= limits.deadlineMs) {
      run.log(`[WARN] live-chat wall-clock cap reached; stopping capture at ${video.id}`);
      stoppedByLimit = true;
      break;
    }
    if (limits.unitsUsed + cost > options.budgetUnits) {
      run.log(
        `[WARN] live-chat budget reached (${limits.unitsUsed}/${options.budgetUnits} units); ` +
          `stopping capture at ${video.id}`,
      );
      stoppedByLimit = true;
      break;
    }
    let page;
    try {
      const token = pageToken;
      page = await run.call(
        `liveChatMessages.list video=${video.id}`,
        () =>
          token === undefined
            ? run.client.listLiveChatMessages({ liveChatId })
            : run.client.listLiveChatMessages({ liveChatId, pageToken: token }),
        cost,
      );
    } catch (err) {
      if (isLiveChatEndedError(err)) {
        run.log(`[chat] ${video.id}: live chat ended`);
        break;
      }
      throw err;
    }
    polls += 1;
    units += cost;
    limits.unitsUsed += cost;
    const rows: LiveChatMessage[] = [];
    for (const item of page.items) {
      const message = toLiveChatMessage(item, video, run.fetchedAt);
      if (message !== undefined) rows.push(message);
    }
    if (rows.length > 0) {
      await run.sink.emit({ chatMessages: rows });
      messages += rows.length;
    }
    if (run.verbose) run.log(`[chat] ${video.id} poll=${polls} messages=${rows.length}`);
    if (page.offlineAt !== undefined && page.offlineAt !== '') break;
    pageToken = page.nextPageToken ?? pageToken;
    const interval =
      Number.isFinite(page.pollingIntervalMillis) && page.pollingIntervalMillis > 0
        ? page.pollingIntervalMillis
        : FALLBACK_POLL_INTERVAL_MS;
    await options.sleep(interval);
  }
  run.log(`[chat] ${video.id} messages=${messages} polls=${polls} units=${units}`);
  return stoppedByLimit;
}

/**
 * The live-chat stage: capture the LiveChatMessages of every on-air
 * Broadcast the enrich stage found, one Broadcast after another, within
 * `options`' budget and wall-clock cap. Needs `state.videos`.
 */
export function createLiveChatStage(options: LiveChatStageOptions): IngestStage {
  return {
    name: 'live-chat',
    run: async (run) => {
      const videos = requireState(run.state, 'videos');
      const liveChatIds = run.state.liveChatIds ?? new Map<string, string>();
      const targets = videos.filter(
        (video) => video.broadcastState === 'live' && liveChatIds.has(video.id),
      );
      run.log(`[chat] Capturing live chat of ${targets.length} on-air Broadcasts...`);
      const limits: CaptureLimits = {
        options,
        deadlineMs: options.now().getTime() + (options.maxDurationMs ?? LIVE_CHAT_MAX_DURATION_MS),
        unitsUsed: 0,
      };
      for (const video of targets) {
        const liveChatId = liveChatIds.get(video.id)!;
        if (await captureBroadcast(run, video, liveChatId, limits)) break;
      }
    },
  };
}
