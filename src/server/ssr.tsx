/**
 * Server-side rendering for ytb-index (`server/ssr`).
 *
 * Source of decisions: wayfinder #20 (T07) + build spec §6 UI (locked),
 * extended by ADR-0005 (operator-triggered ingest surface).
 *
 * Two pure functions turn plain domain data into complete HTML strings:
 *
 *  - `renderCatalog(channel, videos, channels, status)` — the `/` index page
 *    and the explicit `/c/:channelId` page.
 *  - `renderVideo(video, comments, anchors)` — the `/v/:videoId` detail page.
 *
 * Both use Hono's `html` tagged-template helper, which auto-escapes every
 * interpolated value. The catalog page adds a small inline operator script
 * (token storage, trigger fetch, status polling); everything else stays
 * server-rendered.
 *
 * The functions are side-effect free and do not touch the database, so they
 * are cheap to unit-test with hand-built fixtures.
 */
import { html, raw } from 'hono/html';
import type {
  Channel,
  CommentRecord,
  IngestRequest,
  TimeAnchor,
  VideoRecord,
} from '../shared/types.ts';

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

/** Shared catalog-page styles. Kept minimal and utilitarian. */
const CATALOG_STYLES = `
  body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 0 1rem 2rem; max-width: 720px; }
  a { color: #0645ad; }
  .site-header { display: flex; align-items: baseline; gap: 1rem; padding: 1rem 0; border-bottom: 1px solid #ddd; margin-bottom: 1rem; }
  .brand { font-weight: 700; }
  .brand a { text-decoration: none; color: inherit; }
  .channel-switcher label { font-size: 0.875rem; color: #555; margin-right: 0.25rem; }
  .channel-switcher select { min-width: 12rem; }
  .operator-section { background: #f6f6f6; border: 1px solid #e0e0e0; border-radius: 6px; padding: 1rem; margin: 1rem 0; }
  .operator-section h2 { margin: 0 0 0.75rem; font-size: 1rem; }
  .operator-section input[type="text"], .operator-section input[type="password"] { padding: 0.375rem 0.5rem; font: inherit; }
  .operator-section button { padding: 0.375rem 0.75rem; font: inherit; cursor: pointer; }
  .operator-section .inline-form { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; }
  .operator-section .shape-error { color: #b00020; font-size: 0.875rem; margin: 0.5rem 0 0; display: none; }
  .operator-section .status { margin-top: 0.75rem; }
  .operator-section .status strong { text-transform: uppercase; font-size: 0.75rem; letter-spacing: 0.05em; }
  .operator-section .ingest-error { color: #b00020; white-space: pre-wrap; }
  .hero { text-align: center; padding: 3rem 1rem; }
  .hero h2 { margin: 0 0 1rem; }
  .channel h1 { margin-bottom: 0.25rem; }
  .last-refreshed { color: #555; margin-top: 0; }
  .catalog { list-style: none; padding: 0; }
  .video-row { display: flex; gap: 1rem; margin-bottom: 1rem; }
  .video-row .thumbnail img { display: block; }
  .video-row .video-meta { display: flex; flex-direction: column; gap: 0.25rem; }
  .video-title { font-weight: 600; }
  .video-summary { margin: 0; color: #555; font-size: 0.875rem; }
  .visitor-only, .operator-only { display: none; }
`;

/** Wrap page `body` in the shared document shell. */
function page(title: string, body: unknown, includeCatalogStyles = false): string {
  const styles = includeCatalogStyles ? raw(CATALOG_STYLES) : '';
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title}</title>
        ${styles}
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

/** Channel switcher dropdown for the site header. */
function channelSwitcher(channels: Array<{ id: string; title: string }>, currentId?: string): Html {
  if (channels.length === 0) {
    return html`<nav class="channel-switcher">
      <label for="channel-switcher">Channel</label>
      <select id="channel-switcher" disabled>
        <option>—</option>
      </select>
    </nav>`;
  }
  const options = channels.map((ch) =>
    ch.id === currentId
      ? html`<option value="${ch.id}" selected>${ch.title}</option>`
      : html`<option value="${ch.id}">${ch.title}</option>`,
  );
  return html`<nav class="channel-switcher">
    <label for="channel-switcher">Channel</label>
    <select id="channel-switcher">
      <option value="">—</option>
      ${options}
    </select>
  </nav>`;
}

/** Render the current ingest status for an unlocked operator. */
function statusBlock(status: IngestRequest | null): Html {
  if (status === null) {
    return html`<div class="status" id="ingest-status"><p>No ingest requests yet.</p></div>`;
  }
  const counts = `${status.videosWritten} videos / ${status.commentsWritten} comments`;
  const when = relativeDate(status.updatedAt);
  const errorBlock =
    status.status === 'failed' && status.error
      ? html`<p class="ingest-error">${status.error}</p>`
      : '';
  return html`<div class="status" id="ingest-status">
    <p><strong>${status.status}</strong> · ${counts} · updated ${when}</p>
    ${errorBlock}
  </div>`;
}

/** The compact trigger form shown on a populated catalog page. */
function compactTriggerForm(): Html {
  return html`<form id="ingest-trigger-form" class="inline-form" aria-label="Trigger ingest">
      <input
        id="ingest-channel"
        type="text"
        name="channel"
        placeholder="@handle, channel ID, or youtube.com URL"
        required
        size="40"
      />
      <button type="submit">Ingest</button>
    </form>
    <p id="ingest-shape-error" class="shape-error">
      Enter a YouTube handle (@name), channel ID (UC…), or youtube.com channel URL.
    </p>`;
}

/** The hero trigger form shown when no channels exist yet. */
function heroTriggerForm(): Html {
  return html`<div class="hero">
    <h2>Paste a channel to ingest</h2>
    ${compactTriggerForm()}
  </div>`;
}

/** The locked operator gate and the unlocked operator chrome. */
function operatorSection(isEmpty: boolean, status: IngestRequest | null): Html {
  return html`<section class="operator-section" aria-label="Operator tools">
    <div class="visitor-only" id="operator-locked">
      <p>
        <button id="operator-unlock-reveal" type="button">Unlock operator tools</button>
      </p>
      <div id="operator-token-form" style="display:none">
        <p class="inline-form">
          <input
            id="operator-token"
            type="password"
            placeholder="Operator token"
            autocomplete="off"
            size="30"
          />
          <button id="operator-unlock" type="button">Save token</button>
        </p>
      </div>
    </div>
    <div class="operator-only" id="operator-unlocked">
      ${
        isEmpty
          ? heroTriggerForm()
          : html`<h2>Trigger ingest</h2>
              ${compactTriggerForm()}`
      }
      ${statusBlock(status)}
      <p><button id="operator-forget" type="button">Forget token</button></p>
    </div>
  </section>`;
}

/** The small inline script that gates operator chrome and polls status. */
function operatorScript(): Html {
  const script = `(function() {
  var STORAGE_KEY = 'ytb_index_operator_token';
  var locked = document.getElementById('operator-locked');
  var unlocked = document.getElementById('operator-unlocked');
  var tokenForm = document.getElementById('operator-token-form');
  var revealBtn = document.getElementById('operator-unlock-reveal');
  var unlockBtn = document.getElementById('operator-unlock');
  var forgetBtn = document.getElementById('operator-forget');
  var tokenInput = document.getElementById('operator-token');
  var triggerForm = document.getElementById('ingest-trigger-form');
  var channelInput = document.getElementById('ingest-channel');
  var shapeError = document.getElementById('ingest-shape-error');
  var channelSwitcher = document.getElementById('channel-switcher');
  var pollTimer = null;

  function hasToken() { return !!localStorage.getItem(STORAGE_KEY); }

  function setOperatorVisible(show) {
    if (locked) locked.style.display = show ? 'none' : '';
    if (unlocked) unlocked.style.display = show ? '' : 'none';
  }

  function looksLikeChannel(v) {
    v = (v || '').trim();
    if (!v) return false;
    if (/^https?:\\/\\/(www\\.)?youtube\\.com\\/(channel\\/|@|c\\/)/.test(v)) return true;
    if (/^UC[A-Za-z0-9_-]{22}$/.test(v)) return true;
    if (/^@?[A-Za-z0-9_-]{3,30}$/.test(v)) return true;
    return false;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function(c) {
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
    });
  }

  function renderStatus(data) {
    var area = document.getElementById('ingest-status');
    if (!area) return;
    if (!data) { area.innerHTML = '<p>No ingest requests yet.</p>'; return; }
    var html = '<p><strong>' + escapeHtml(data.status) + '</strong> · ' +
      (data.videosWritten || 0) + ' videos / ' + (data.commentsWritten || 0) + ' comments' +
      ' · updated ' + new Date(data.updatedAt).toLocaleString() + '</p>';
    if (data.status === 'failed' && data.error) {
      html += '<p class="ingest-error">' + escapeHtml(data.error) + '</p>';
    }
    area.innerHTML = html;
  }

  async function pollStatus() {
    try {
      var res = await fetch('/api/ingest/status');
      if (!res.ok) return;
      var data = await res.json();
      renderStatus(data);
      if (data && (data.status === 'queued' || data.status === 'running')) {
        pollTimer = setTimeout(pollStatus, 3000);
      }
    } catch (e) {}
  }

  function startPolling() {
    if (pollTimer) clearTimeout(pollTimer);
    pollStatus();
  }

  if (revealBtn && tokenForm) {
    revealBtn.addEventListener('click', function() {
      tokenForm.style.display = tokenForm.style.display === 'none' ? '' : 'none';
      if (tokenInput) tokenInput.focus();
    });
  }

  if (unlockBtn && tokenInput) {
    unlockBtn.addEventListener('click', function() {
      var value = tokenInput.value.trim();
      if (value) {
        localStorage.setItem(STORAGE_KEY, value);
        setOperatorVisible(true);
        startPolling();
      }
    });
  }

  if (forgetBtn) {
    forgetBtn.addEventListener('click', function() {
      localStorage.removeItem(STORAGE_KEY);
      setOperatorVisible(false);
      if (tokenInput) tokenInput.value = '';
    });
  }

  if (triggerForm && channelInput) {
    triggerForm.addEventListener('submit', async function(e) {
      e.preventDefault();
      var value = channelInput.value.trim();
      if (!looksLikeChannel(value)) {
        if (shapeError) shapeError.style.display = '';
        return;
      }
      if (shapeError) shapeError.style.display = 'none';
      var token = localStorage.getItem(STORAGE_KEY);
      if (!token) return;
      try {
        var res = await fetch('/api/ingest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: JSON.stringify({ channel: value })
        });
        if (res.status === 401) { alert('Invalid operator token.'); return; }
        if (res.status === 409) {
          var body = await res.json().catch(function() { return {}; });
          alert('An ingest is already running for this channel. Request: ' + (body.requestId || 'unknown'));
          startPolling();
          return;
        }
        if (!res.ok) { alert('Ingest request failed: ' + res.status); return; }
        channelInput.value = '';
        startPolling();
      } catch (err) {
        alert('Network error: ' + (err && err.message ? err.message : err));
      }
    });
  }

  if (channelSwitcher) {
    channelSwitcher.addEventListener('change', function(e) {
      var value = e.target.value;
      if (value) window.location.href = '/c/' + encodeURIComponent(value);
    });
  }

  setOperatorVisible(hasToken());
  if (hasToken()) startPolling();
})();`;
  return html`<script>
    ${raw(script)};
  </script>`;
}

/**
 * Render the `/` catalog index or `/c/:channelId` page.
 *
 * When `channel` is `null` (nothing ingested yet) an empty state is shown and
 * the trigger input becomes the onboarding hero.
 */
export function renderCatalog(
  channel: Channel | null,
  videos: CatalogVideo[],
  channels: Array<{ id: string; title: string }> = [],
  status: IngestRequest | null = null,
): string {
  const title = channel?.title ?? 'ytb-index';
  const currentChannelId = channel?.id;
  const isEmpty = channel === null;

  const body = html`<header class="site-header">
      <div class="brand"><a href="/">ytb-index</a></div>
      ${channelSwitcher(channels, currentChannelId)}
    </header>
    <main>
      ${operatorSection(isEmpty, status)}
      ${
        isEmpty
          ? html`<p class="visitor-only">No channels ingested yet.</p>`
          : html`<header class="channel">
                <h1>${channel.title}</h1>
                <p class="last-refreshed">Last refreshed: ${channel.fetchedAt.slice(0, 10)}</p>
              </header>
              <ul class="catalog">
                ${videos.map((video) => catalogRow(video))}
              </ul>`
      }
    </main>
    ${operatorScript()}`;

  return page(title, body, true);
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

/**
 * Wrap every `TimeAnchor` substring inside `text` in a click-jump link.
 *
 * Anchors are located by `charPosition` + `rawText.length` (not by searching
 * for the raw text), so repeated timestamps linkify independently. Anchors are
 * processed earliest-first; an anchor is skipped when it overlaps a previous
 * one, runs past the end of the text, or no longer matches the text at its
 * recorded position (e.g. the redacted TTL placeholder, which contains no
 * anchors). Surrounding text is escaped by the `html` helper; the anchor tags
 * are injected as already-escaped HTML so they are not double-encoded.
 */
function linkifyAnchors(text: string, anchors: Anchor[], videoId: string): Html {
  const sorted = [...anchors].sort((a, b) => a.charPosition - b.charPosition);
  const parts: Array<Html | string> = [];
  let cursor = 0;

  for (const anchor of sorted) {
    const start = anchor.charPosition;
    const end = start + anchor.rawText.length;
    if (start < cursor || end > text.length || text.slice(start, end) !== anchor.rawText) {
      continue;
    }
    parts.push(text.slice(cursor, start));
    parts.push(
      html`<a
        target="_blank"
        rel="noopener noreferrer"
        href="https://www.youtube.com/watch?v=${videoId}&t=${anchor.seconds}s"
        >${anchor.rawText}</a
      >`,
    );
    cursor = end;
  }

  parts.push(text.slice(cursor));
  return html`${parts}`;
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
    <p class="comment-body">${linkifyAnchors(comment.text, anchors, videoId)}</p>
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
