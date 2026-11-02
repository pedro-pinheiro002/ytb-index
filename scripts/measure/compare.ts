/**
 * Compare a CommentSample with the full comments of the same VideoRecords
 * (`scripts/measure/compare`), for ADR-0012's first validation (proposed):
 * do the most relevant threads hold the timestamped comments and the same
 * "Key moments" as the full set?
 *
 * Pure: takes the rows `toCommentRows` produces for each side and returns
 * per-video and aggregate numbers. "Key moments" are computed with the very
 * function the video page uses (`keyMoments` in `src/server/ssr.tsx`), so the
 * comparison measures what a Visitor would see.
 */
import { keyMoments } from '../../src/server/ssr.tsx';
import type { CommentRecord, TimeAnchor } from '../../src/shared/types.ts';

/** One side of the comparison: what `toCommentRows` returned for it. */
export interface CommentSide {
  comments: CommentRecord[];
  anchors: TimeAnchor[];
}

/** Knobs of {@link compareSamples}. */
export interface CompareOptions {
  /** How many Key moments the video page shows; default 8. */
  topK?: number;
  /** A sample moment within this many seconds of a full one counts as found; default 10. */
  toleranceSeconds?: number;
}

/** Per-VideoRecord comparison. Ratios are `null` when the full side has nothing to find. */
export interface VideoComparison {
  videoId: string;
  fullComments: number;
  sampleComments: number;
  fullTimestamped: number;
  sampleTimestamped: number;
  /** Full timestamped CommentRecords also present in the sample. */
  timestampedRecall: number | null;
  /** Full TimeAnchors (comment, seconds) also present in the sample. */
  anchorRecall: number | null;
  fullKeyMoments: number[];
  sampleKeyMoments: number[];
  /** Share of the full Key moments the sample shows at exactly the same second. */
  keyMomentsExact: number | null;
  /** Same, allowing `toleranceSeconds` of difference. */
  keyMomentsTolerant: number | null;
  /** Whether the most cited moment is the same second on both sides. */
  topMomentMatch: boolean | null;
}

/** Totals over every compared VideoRecord. */
export interface ComparisonSummary {
  videos: number;
  /** VideoRecords whose full side has at least one TimeAnchor. */
  videosWithAnchors: number;
  fullComments: number;
  sampleComments: number;
  fullTimestamped: number;
  sampleTimestamped: number;
  /** Pooled over all VideoRecords (micro average). */
  timestampedRecall: number | null;
  anchorRecall: number | null;
  /** Mean over `videosWithAnchors` (macro average). */
  meanKeyMomentsExact: number | null;
  meanKeyMomentsTolerant: number | null;
  topMomentMatchRate: number | null;
  /** VideoRecords with timestamped comments in full but none in the sample. */
  videosMissingAllAnchors: string[];
}

/** Result of {@link compareSamples}. */
export interface ComparisonReport {
  perVideo: VideoComparison[];
  summary: ComparisonSummary;
}

interface VideoSide {
  comments: CommentRecord[];
  anchors: TimeAnchor[];
}

function splitByVideo(side: CommentSide): Map<string, VideoSide> {
  const videoOf = new Map<string, string>();
  const byVideo = new Map<string, VideoSide>();
  const bucket = (videoId: string): VideoSide => {
    let entry = byVideo.get(videoId);
    if (entry === undefined) {
      entry = { comments: [], anchors: [] };
      byVideo.set(videoId, entry);
    }
    return entry;
  };
  for (const comment of side.comments) {
    videoOf.set(comment.id, comment.videoId);
    bucket(comment.videoId).comments.push(comment);
  }
  for (const anchor of side.anchors) {
    const videoId = videoOf.get(anchor.commentId);
    if (videoId !== undefined) bucket(videoId).anchors.push(anchor);
  }
  return byVideo;
}

function ratio(found: number, total: number): number | null {
  return total === 0 ? null : found / total;
}

function mean(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : present.reduce((a, b) => a + b, 0) / present.length;
}

function timestampedIds(side: VideoSide): Set<string> {
  return new Set(side.anchors.map((anchor) => anchor.commentId));
}

function anchorKeys(side: VideoSide): Set<string> {
  return new Set(side.anchors.map((anchor) => `${anchor.commentId}@${anchor.seconds}`));
}

function countFound(wanted: Iterable<string>, have: Set<string>): number {
  let found = 0;
  for (const key of wanted) if (have.has(key)) found += 1;
  return found;
}

/**
 * Compare the sample with the full comments, per VideoRecord in `videoIds`
 * and in aggregate. A VideoRecord missing from a side counts as having no
 * comments there.
 */
export function compareSamples(
  videoIds: readonly string[],
  full: CommentSide,
  sample: CommentSide,
  options: CompareOptions = {},
): ComparisonReport {
  const topK = options.topK ?? 8;
  const tolerance = options.toleranceSeconds ?? 10;
  const fullByVideo = splitByVideo(full);
  const sampleByVideo = splitByVideo(sample);
  const empty: VideoSide = { comments: [], anchors: [] };

  const perVideo: VideoComparison[] = videoIds.map((videoId) => {
    const f = fullByVideo.get(videoId) ?? empty;
    const s = sampleByVideo.get(videoId) ?? empty;
    const fullTs = timestampedIds(f);
    const sampleTs = timestampedIds(s);
    const fullAnchorKeys = anchorKeys(f);
    const fullMoments = keyMoments(f.anchors, topK).map((moment) => moment.seconds);
    const sampleMoments = keyMoments(s.anchors, topK).map((moment) => moment.seconds);
    const exact = fullMoments.filter((second) => sampleMoments.includes(second)).length;
    const tolerant = fullMoments.filter((second) =>
      sampleMoments.some((other) => Math.abs(other - second) <= tolerance),
    ).length;
    const fullTop = keyMoments(f.anchors, 1)[0]?.seconds;
    const sampleTop = keyMoments(s.anchors, 1)[0]?.seconds;
    return {
      videoId,
      fullComments: f.comments.length,
      sampleComments: s.comments.length,
      fullTimestamped: fullTs.size,
      sampleTimestamped: sampleTs.size,
      timestampedRecall: ratio(countFound(fullTs, sampleTs), fullTs.size),
      anchorRecall: ratio(countFound(fullAnchorKeys, anchorKeys(s)), fullAnchorKeys.size),
      fullKeyMoments: fullMoments,
      sampleKeyMoments: sampleMoments,
      keyMomentsExact: ratio(exact, fullMoments.length),
      keyMomentsTolerant: ratio(tolerant, fullMoments.length),
      topMomentMatch: fullTop === undefined ? null : fullTop === sampleTop,
    };
  });

  const withAnchors = perVideo.filter((video) => video.fullTimestamped > 0);
  let fullTsTotal = 0;
  let foundTsTotal = 0;
  let fullAnchorTotal = 0;
  let foundAnchorTotal = 0;
  for (const videoId of videoIds) {
    const f = fullByVideo.get(videoId) ?? empty;
    const s = sampleByVideo.get(videoId) ?? empty;
    const fullTs = timestampedIds(f);
    const fullKeys = anchorKeys(f);
    fullTsTotal += fullTs.size;
    foundTsTotal += countFound(fullTs, timestampedIds(s));
    fullAnchorTotal += fullKeys.size;
    foundAnchorTotal += countFound(fullKeys, anchorKeys(s));
  }
  const topMatches = withAnchors.map((video) => (video.topMomentMatch === true ? 1 : 0));

  return {
    perVideo,
    summary: {
      videos: perVideo.length,
      videosWithAnchors: withAnchors.length,
      fullComments: sum(perVideo.map((video) => video.fullComments)),
      sampleComments: sum(perVideo.map((video) => video.sampleComments)),
      fullTimestamped: fullTsTotal,
      sampleTimestamped: sum(perVideo.map((video) => video.sampleTimestamped)),
      timestampedRecall: ratio(foundTsTotal, fullTsTotal),
      anchorRecall: ratio(foundAnchorTotal, fullAnchorTotal),
      meanKeyMomentsExact: mean(withAnchors.map((video) => video.keyMomentsExact)),
      meanKeyMomentsTolerant: mean(withAnchors.map((video) => video.keyMomentsTolerant)),
      topMomentMatchRate: ratio(sum(topMatches), topMatches.length),
      videosMissingAllAnchors: withAnchors
        .filter((video) => video.sampleTimestamped === 0)
        .map((video) => video.videoId),
    },
  };
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}
