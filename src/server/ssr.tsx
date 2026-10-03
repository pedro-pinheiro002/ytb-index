/**
 * Server-side rendering for ytb-index (`server/ssr`).
 *
 * Source of decisions: wayfinder #20 (T07) + build spec §6 UI (locked).
 *
 * Two pure functions turn plain domain data into complete HTML strings:
 *
 *  - `renderCatalog(channel, videos)` — the `/` index page.
 *  - `renderVideo(video, comments, anchors)` — the `/v/:videoId` detail page.
 *
 * Both use Hono's `html` tagged-template helper, which auto-escapes every
 * interpolated value. There is no client-side JavaScript: every page is a
 * single self-contained string returned to the route handler.
 *
 * The functions are side-effect free and do not touch the database, so they
 * are cheap to unit-test with hand-built fixtures.
 */
import { html } from 'hono/html';
import type { Channel, CommentRecord, TimeAnchor, VideoRecord } from '../shared/types.ts';

/** `Anchor` is the shared `TimeAnchor` domain type. */
export type Anchor = TimeAnchor;

/**
 * A catalog row's video plus the derived timestamped-comment count that the
 * catalog query computes for the summary line.
 *
 * The field is optional so plain `VideoRecord`s (and `VideoRecord[]`) remain
 * assignable; when absent the summary shows `0 timestamped`.
 */
export type CatalogVideo = VideoRecord & {
  /** Number of ingested comments on this video that hold ≥1 anchor. */
  timestampedCount?: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The return type of Hono's `html` helper. Helpers that return HTML must
 * return this (not a plain `string`) so nested interpolation keeps Hono's
 * `isEscaped` marker and is not double-escaped. Only the exported entry points
 * flatten to a plain `string`.
 */
type Html = ReturnType<typeof html>;

/**
 * Human-friendly relative date (spec §6):
 * `today`, `yesterday`, `N days ago`, or the ISO date (`YYYY-MM-DD`) at ≥30 days.
 *
 * Comparison is on UTC calendar days so a timestamp earlier the same day still
 * reads "today". `now` is injectable for deterministic tests.
 */
export function relativeDate(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const startOfThen = Date.UTC(then.getUTCFullYear(), then.getUTCMonth(), then.getUTCDate());
  const days = Math.round((startOfToday - startOfThen) / DAY_MS);

  if (days <= 0) {
    return 'today';
  }
  if (days === 1) {
    return 'yesterday';
  }
  if (days < 30) {
    return `${days} days ago`;
  }
  return iso.slice(0, 10);
}

/** Format a seconds offset as `M:SS` (or `H:MM:SS` past an hour). */
export function formatTimestamp(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = String(seconds % 60).padStart(2, '0');
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${secs}`;
  }
  return `${minutes}:${secs}`;
}

/** Wrap page `body` in the shared document shell. */
function page(title: string, body: unknown): string {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title}</title>
      </head>
      <body>
        ${body}
      </body>
    </html>`.toString();
}

/** One catalog row: thumbnail, title link, relative date, summary. */
function catalogRow(video: CatalogVideo): Html {
  const timestamped = video.timestampedCount ?? 0;
  const alt = video.title === '' ? 'Video thumbnail' : video.title;
  return html`<li class="video-row">
    <a class="thumbnail" href="/v/${video.id}">
      <img src="${video.thumbnailUrl}" alt="${alt}" width="120" />
    </a>
    <div class="video-meta">
      <a class="video-title" href="/v/${video.id}">${video.title}</a>
      <time datetime="${video.publishedAt}">${relativeDate(video.publishedAt)}</time>
      <p class="video-summary">${video.commentCount} comments / ${timestamped} timestamped</p>
    </div>
  </li>`;
}

/**
 * Render the `/` catalog index.
 *
 * When `channel` is `null` (nothing ingested yet) an empty state is shown.
 */
export function renderCatalog(channel: Channel | null, videos: CatalogVideo[]): string {
  if (channel === null) {
    return page(
      'ytb-index',
      html`<main>
        <p class="empty">No videos ingested. Run pnpm ingest <channel> to populate.</p>
      </main>`,
    );
  }

  return page(
    `${channel.title} — ytb-index`,
    html`<header class="channel">
        <h1>${channel.title}</h1>
        <p class="last-refreshed">Last refreshed: ${channel.fetchedAt.slice(0, 10)}</p>
      </header>
      <main>
        <ul class="catalog">
          ${videos.map((video) => catalogRow(video))}
        </ul>
      </main>`,
  );
}

/**
 * The `Timestamps: …` footer for a timestamped comment: one click-jump link per
 * anchor, sorted by in-text position and separated by a middle dot.
 *
 * Returns an empty string when the comment has no anchors, so non-timestamped
 * comments render without the footer (spec §6 empty states).
 */
function timestampsFooter(videoId: string, anchors: Anchor[]): Html | string {
  if (anchors.length === 0) {
    return '';
  }
  const sorted = [...anchors].sort((a, b) => a.charPosition - b.charPosition);
  const links = sorted.map(
    (anchor, index) =>
      html`${index > 0 ? ' · ' : ''}<a
          target="_blank"
          rel="noopener noreferrer"
          href="https://www.youtube.com/watch?v=${videoId}&t=${anchor.seconds}s"
          >${formatTimestamp(anchor.seconds)}</a
        >`,
  );
  return html`<p class="timestamps">Timestamps: ${links}</p>`;
}

/** One top-level comment; timestamped comments get the accent border + footer. */
function commentItem(videoId: string, comment: CommentRecord, anchors: Anchor[]): Html {
  const timestamped = anchors.length > 0;
  const style = timestamped
    ? html` style="border-left: 3px solid #ff0033; padding-left: 12px"`
    : '';
  return html`<li class="comment${timestamped ? ' timestamped' : ''}" ${style}>
    <p class="comment-meta">
      ${comment.author} ·
      <time datetime="${comment.publishedAt}">${relativeDate(comment.publishedAt)}</time>
    </p>
    <p class="comment-body"><b>${comment.text}</b></p>
    ${timestampsFooter(videoId, anchors)}
  </li>`;
}

/**
 * Render the `/v/:videoId` detail page.
 *
 * `comments` arrive newest-first from the read query; `anchors` is the flat set
 * of anchors for every comment on the video (grouped here by `commentId`).
 */
export function renderVideo(
  video: VideoRecord,
  comments: CommentRecord[],
  anchors: Anchor[],
): string {
  const anchorsByComment = new Map<string, Anchor[]>();
  for (const anchor of anchors) {
    const list = anchorsByComment.get(anchor.commentId);
    if (list === undefined) {
      anchorsByComment.set(anchor.commentId, [anchor]);
    } else {
      list.push(anchor);
    }
  }

  const body =
    comments.length === 0
      ? html`<p class="empty">No comments on this video.</p>`
      : html`<ul class="comments">
          ${comments.map((comment) =>
            commentItem(video.id, comment, anchorsByComment.get(comment.id) ?? []),
          )}
        </ul>`;

  const alt = video.title === '' ? 'Video thumbnail' : video.title;
  return page(
    `${video.title} — ytb-index`,
    html`<header class="video">
        <h1>${video.title}</h1>
        <img class="thumbnail" src="${video.thumbnailUrl}" alt="${alt}" width="320" />
        <p class="published">
          <time datetime="${video.publishedAt}">${relativeDate(video.publishedAt)}</time>
        </p>
        <p>
          <a
            target="_blank"
            rel="noopener noreferrer"
            href="https://www.youtube.com/watch?v=${video.id}"
            >Watch on YouTube</a
          >
        </p>
      </header>
      <main>${body}</main>`,
  );
}
