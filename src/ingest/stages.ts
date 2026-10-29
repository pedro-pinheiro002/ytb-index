/**
 * Ingest stages and the row sink (`src/ingest/stages`), from R1 (#45).
 *
 * An Ingest is an ordered list of {@link IngestStage}s run over one shared
 * {@link IngestRun}: the client, the quota-billing `call`, `log`, `verbose`,
 * `fetchedAt`, the operator's ChannelInput, the {@link IngestState} earlier
 * stages leave behind, and the {@link RowSink} every stage emits Catalog rows
 * into. Stages never return rows and never write: the sink decides when rows
 * land. {@link createBufferingSink} holds the whole run for the CLI's single
 * atomic write (ADR-0001); a sink that flushes inside `emit` (live chat,
 * `docs/spec/v2.md` → Modules) plugs into the same seam without touching any
 * stage. The default v1 stage list lives next to its steps in
 * `./pipeline.ts`.
 *
 * F3a (#49): `client` is the single `YouTubeClient` (Replies via
 * `listComments`), and the state also records skipped upcoming Broadcasts.
 *
 * F3b (#52, ADR-0009): `call` takes the call's quota units (a live-chat poll
 * costs 5), batches may carry LiveChatMessages, the state carries each on-air
 * Broadcast's live chat id and the videos whose comments were skipped, and
 * {@link runIngestStages} can resume from an earlier run's state, so the CLI
 * runs the live-chat stage after the main write into a flushing sink.
 */
import type { YouTubeClient } from '../yt/client.ts';
import type { IngestRows } from '../db/queries.ts';
import type {
  Channel,
  ChannelInput,
  CommentRecord,
  LiveChatMessage,
  TimeAnchor,
  VideoRecord,
} from '../shared/types.ts';

/** What every step needs from its caller. */
export interface PipelineContext {
  client: YouTubeClient;
  /**
   * Run one API call; the caller bills quota and logs it. `units` is the
   * call's quota cost (`QUOTA_COST`); omitted means 1.
   */
  call: <T>(label: string, run: () => Promise<T>, units?: number) => Promise<T>;
  /** Progress line on stdout. */
  log: (message: string) => void;
  /** Log per-video comment counts and timings. */
  verbose: boolean;
  /** ISO timestamp stamped on every row of the run. */
  fetchedAt: string;
}

/**
 * One emission of Catalog rows. A stage emits a CommentRecord's TimeAnchors
 * in the same batch as the CommentRecord, so a sink can keep foreign keys
 * satisfied however it chunks its writes.
 */
export type IngestRowBatch =
  | { channel: Channel }
  | { videos: VideoRecord[] }
  | { comments: CommentRecord[]; anchors: TimeAnchor[] }
  | { chatMessages: LiveChatMessage[] };

/**
 * Where an Ingest's rows go. `emit` is awaited before the stage continues, so
 * a sink may buffer or write immediately; a throw aborts the Ingest.
 */
export interface RowSink {
  emit: (batch: IngestRowBatch) => Promise<void>;
}

/** What earlier stages leave for later ones. Each stage fills its own field. */
export interface IngestState {
  /** The resolved Channel. */
  channel?: Channel;
  /** IDs from the Channel's uploads playlist, in playlist order. */
  videoIds?: string[];
  /** Enriched VideoRecords (upcoming Broadcasts excluded). */
  videos?: VideoRecord[];
  /** Upcoming Broadcasts the enrich stage skipped, not stored (F3a, #49). */
  skippedVideoIds?: string[];
  /**
   * Stored videos whose comments were not captured (`commentsDisabled` /
   * `videoNotFound`), set by the comments stage (F3b, #52).
   */
  commentsSkippedVideoIds?: string[];
  /**
   * `videoId → activeLiveChatId` of each on-air Broadcast, set by the enrich
   * stage; never stored (ADR-0009: the id disappears when the stream ends).
   */
  liveChatIds?: Map<string, string>;
}

/** The context every stage of one Ingest shares. */
export interface IngestRun extends PipelineContext {
  /** The parsed `<channel>` argument. */
  readonly input: ChannelInput;
  /** Mutable hand-off between stages. */
  readonly state: IngestState;
  /** Destination for every row the stage produces. */
  readonly sink: RowSink;
}

/** One step of an Ingest. Reads and writes `run.state`, emits into `run.sink`. */
export interface IngestStage {
  /** Short name for diagnostics. */
  readonly name: string;
  run: (run: IngestRun) => Promise<void>;
}

/**
 * Run `stages` in order over one shared context and state, emitting into
 * `sink`. Throws whatever a stage or the sink throws; later stages do not run.
 * `state` (default: a fresh one) lets a later run continue from what an
 * earlier run's stages left, e.g. the live-chat stage into another sink.
 */
export async function runIngestStages(
  ctx: PipelineContext,
  input: ChannelInput,
  stages: readonly IngestStage[],
  sink: RowSink,
  state: IngestState = {},
): Promise<IngestState> {
  const run: IngestRun = { ...ctx, input, state, sink };
  for (const stage of stages) {
    await stage.run(run);
  }
  return run.state;
}

/**
 * Read a field an earlier stage must have set; throws a clear error when the
 * stage list is misordered.
 */
export function requireState<K extends keyof IngestState>(
  state: IngestState,
  key: K,
): NonNullable<IngestState[K]> {
  const value = state[key];
  if (value === undefined) {
    throw new Error(`Ingest stage order: ${key} is not available yet`);
  }
  return value as NonNullable<IngestState[K]>;
}

/** A sink that keeps every row in memory until {@link BufferingSink.rows}. */
export interface BufferingSink extends RowSink {
  /** Every row emitted so far, as one bundle for `ingestStatements`. */
  rows: () => IngestRows;
}

/**
 * Buffer a whole Ingest in memory (the local atomic path, ADR-0001).
 * `rows()` throws if no Channel was emitted.
 */
export function createBufferingSink(): BufferingSink {
  let channel: Channel | undefined;
  const videos: VideoRecord[] = [];
  const comments: CommentRecord[] = [];
  const anchors: TimeAnchor[] = [];
  const chatMessages: LiveChatMessage[] = [];
  return {
    emit: async (batch) => {
      if ('channel' in batch) {
        channel = batch.channel;
      } else if ('videos' in batch) {
        // Loops, not spread: a Channel can have more rows than call arguments allow.
        for (const video of batch.videos) videos.push(video);
      } else if ('chatMessages' in batch) {
        for (const message of batch.chatMessages) chatMessages.push(message);
      } else {
        for (const comment of batch.comments) comments.push(comment);
        for (const anchor of batch.anchors) anchors.push(anchor);
      }
    },
    rows: () => {
      if (channel === undefined) {
        throw new Error('Ingest emitted no Channel');
      }
      return chatMessages.length > 0
        ? { channel, videos, comments, anchors, chatMessages }
        : { channel, videos, comments, anchors };
    },
  };
}
