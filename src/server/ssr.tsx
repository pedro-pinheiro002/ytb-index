/**
 * Server-side rendering for ytb-index (`server/ssr`).
 *
 * Source of decisions: wayfinder #20 (T07) + build spec §6 UI, extended by
 * ADR-0005 (operator-triggered ingest surface). The visual layer follows
 * Material Design 3 with a YouTube-flavoured palette (see `./styles.ts`).
 *
 * Pure functions turn plain domain data into complete HTML strings:
 *
 *  - `renderCatalog(channel, videos, channels, status)` — the `/` index page
 *    and the explicit `/c/:channelId` page: a YouTube-style video grid.
 *  - `renderVideo(video, comments, anchors)` — the `/v/:videoId` detail page:
 *    a watch-page layout with the comments and a "Key moments" panel.
 *  - `renderNotFound(message)` — the shared 404 page.
 *
 * All use Hono's `html` tagged-template helper, which auto-escapes every
 * interpolated value. Pages carry two small inline scripts at most (catalog
 * search, and operator token + OperatorKey storage / key check / trigger fetch
 * / status polling, F6 #51);
 * everything else stays server-rendered and works without JavaScript.
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
import { STYLES } from './styles.ts';

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

/** One entry of the "Key moments" panel: a video offset and how many comments cite it. */
export interface KeyMoment {
  /** Seconds offset from the video start. */
  seconds: number;
  /** Number of distinct comments holding a `TimeAnchor` at this offset. */
  comments: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The return type of Hono's `html` helper. Helpers that return HTML must
 * return this (not a plain `string`) so nested interpolation keeps Hono's
 * `isEscaped` marker and is not double-escaped. Only the exported entry points
 * flatten to a plain `string`.
 */
export type Html = ReturnType<typeof html>;

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

/**
 * Format an ISO-8601 duration (`contentDetails.duration`, e.g. `PT1H2M3S`) as
 * the thumbnail badge text (`1:02:03`). Returns `''` for a zero or unparseable
 * duration (live streams report `P0D`), so the badge is omitted.
 */
export function formatDuration(iso8601: string): string {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso8601);
  if (match === null) {
    return '';
  }
  const [, days = '0', hours = '0', minutes = '0', seconds = '0'] = match;
  const total =
    Number(days) * 86400 + Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
  return total > 0 ? formatTimestamp(total) : '';
}

/** Format a count the way YouTube does: `950`, `1.2K`, `3.4M`. */
export function formatCount(value: number): string {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(
    value,
  );
}

/**
 * The "Key moments" of a video: the offsets its comments cite most.
 *
 * Anchors are grouped by `seconds` and counted once per comment (a comment
 * repeating `1:23` cites it once). The `limit` most-cited offsets are kept,
 * earlier offsets winning ties, and returned in playback order.
 */
export function keyMoments(anchors: Anchor[], limit = 8): KeyMoment[] {
  const citing = new Map<number, Set<string>>();
  for (const anchor of anchors) {
    const set = citing.get(anchor.seconds) ?? new Set<string>();
    set.add(anchor.commentId);
    citing.set(anchor.seconds, set);
  }
  return [...citing]
    .map(([seconds, comments]) => ({ seconds, comments: comments.size }))
    .sort((a, b) => b.comments - a.comments || a.seconds - b.seconds)
    .slice(0, limit)
    .sort((a, b) => a.seconds - b.seconds);
}

/** A stable hue (0–359) for an avatar, derived from its label. */
function avatarHue(label: string): number {
  let hash = 0;
  for (const char of label) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 360;
  }
  return hash;
}

/** A Material-style letter avatar for a channel or comment author. */
function avatar(label: string, large = false): Html {
  const initial = [...label.replace(/^@/, '').trim()][0] ?? '?';
  return html`<span
    class="avatar${large ? ' avatar-lg' : ''}"
    style="--avatar-hue: ${avatarHue(label)}"
    aria-hidden="true"
    >${initial}</span
  >`;
}

/** Material Symbols paths (Apache-2.0) for the handful of icons the UI uses. */
const ICON_PATHS = {
  search:
    'M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
  key: 'M12.65 10A5.99 5.99 0 0 0 7 6c-3.31 0-6 2.69-6 6s2.69 6 6 6a5.99 5.99 0 0 0 5.65-4H17v4h4v-4h2v-4H12.65zM7 14c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z',
  dropDown: 'M7 10l5 5 5-5z',
  schedule:
    'M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z',
  comment:
    'M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z',
  thumbUp:
    'M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z',
  arrowBack: 'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z',
  library:
    'M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-8 12.5v-9l6 4.5-6 4.5z',
  forum:
    'M21 6h-2v9H6v2c0 .55.45 1 1 1h11l4 4V7c0-.55-.45-1-1-1zm-4 6V3c0-.55-.45-1-1-1H3c-.55 0-1 .45-1 1v14l4-4h10c.55 0 1-.45 1-1z',
  logout:
    'M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z',
  bolt: 'M11 21h-1l1-7H7.5c-.58 0-.57-.32-.38-.66.19-.34.05-.08.07-.12C8.48 10.94 10.42 7.54 13 3h1l-1 7h3.5c.49 0 .56.33.47.51l-.07.15C12.96 17.55 11 21 11 21z',
} as const;

/** The name of one of the UI's inline icons. */
export type IconName = keyof typeof ICON_PATHS;

/** An inline SVG icon; decorative unless the caller labels its container. */
export function icon(name: IconName, small = false): Html {
  return html`<svg
    class="icon${small ? ' icon-sm' : ''}"
    viewBox="0 0 24 24"
    aria-hidden="true"
    focusable="false"
  >
    <path d="${ICON_PATHS[name]}" />
  </svg>`;
}

/** The red play-button wordmark in the top app bar. */
const BRAND_MARK = html`<svg class="brand-mark" viewBox="0 0 30 21" aria-hidden="true">
  <rect class="bg" width="30" height="21" rx="6" />
  <path class="fg" d="M12 6v9l8-4.5z" />
</svg>`;

/** The large play button over the watch-page thumbnail. */
const PLAY_BUTTON = html`<svg class="play" viewBox="0 0 68 48" aria-hidden="true">
  <path
    class="bg"
    d="M66.52 7.74c-.78-2.93-2.49-5.41-5.42-6.19C55.79.13 34 0 34 0S12.21.13 6.9 1.55c-2.93.78-4.63 3.26-5.42 6.19C.06 13.05 0 24 0 24s.06 10.95 1.48 16.26c.78 2.93 2.49 5.41 5.42 6.19C12.21 47.87 34 48 34 48s21.79-.13 27.1-1.55c2.93-.78 4.64-3.26 5.42-6.19C67.94 34.95 68 24 68 24s-.06-10.95-1.48-16.26z"
  />
  <path class="fg" d="M45 24 27 14v20" />
</svg>`;

const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 30 21'%3E%3Crect width='30' height='21' rx='6' fill='%23ff0033'/%3E%3Cpath d='M12 6v9l8-4.5z' fill='%23fff'/%3E%3C/svg%3E";

/** What goes in the top app bar besides the brand. */
export interface ShellOptions {
  /**
   * Render the top-bar search field: a GET form to `/search` (F5 #53) that
   * also filters the catalog grid by title as the visitor types.
   */
  search?: boolean;
  /** Extra controls on the right of the top app bar. */
  actions?: Html | string;
  /** Inline scripts appended to the body. */
  scripts?: Html | string;
}

/** Wrap page `body` in the shared document shell: head, top app bar, snackbar. */
export function page(title: string, body: Html, options: ShellOptions = {}): string {
  const search = options.search
    ? html`<form class="search" role="search" method="get" action="/search">
        <label class="search-field">
          ${icon('search')}
          <span class="sr-only">Search the Catalog</span>
          <input
            id="video-search"
            type="search"
            name="q"
            placeholder="Search"
            autocomplete="off"
            aria-keyshortcuts="/"
          />
        </label>
      </form>`
    : html`<div class="search"></div>`;
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#0f0f0f" media="(prefers-color-scheme: dark)" />
        <title>${title}</title>
        <link rel="icon" href="${FAVICON}" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Roboto+Mono&family=Roboto:wght@400;500;700&display=swap"
        />
        <style>
          ${raw(STYLES)}
        </style>
      </head>
      <body>
        <header class="top-app-bar">
          <a class="brand" href="/" aria-label="ytb-index home"
            >${BRAND_MARK}<span class="brand-text">ytb-index</span></a
          >
          ${search}
          <div class="app-actions">${options.actions ?? ''}</div>
        </header>
        <main class="page">${body}</main>
        <div id="snackbar" class="snackbar" role="status" aria-live="polite"></div>
        ${options.scripts ?? ''}
      </body>
    </html>`.toString();
}

/** One catalog card: 16:9 thumbnail with badges, title link, byline, summary. */
function catalogRow(video: CatalogVideo): Html {
  const timestamped = video.timestampedCount ?? 0;
  const alt = video.title === '' ? 'Video thumbnail' : video.title;
  const duration = formatDuration(video.durationIso8601);
  return html`<li class="video-card" data-title="${video.title.toLowerCase()}">
    <a class="thumbnail" href="/v/${video.id}" tabindex="-1">
      <img src="${video.thumbnailUrl}" alt="${alt}" width="480" height="270" loading="lazy" />
      ${
        timestamped > 0
          ? html`<span class="ts-badge" title="${timestamped} timestamped comments"
              >${icon('schedule', true)}${timestamped}</span
            >`
          : ''
      }
      ${duration === '' ? '' : html`<span class="duration">${duration}</span>`}
    </a>
    <div class="video-meta">
      <a class="video-title" href="/v/${video.id}" title="${video.title}">${video.title}</a>
      <p class="video-byline">
        <span>${formatCount(video.viewCount)} views</span>
        <time datetime="${video.publishedAt}">${relativeDate(video.publishedAt)}</time>
      </p>
      <p class="video-summary">
        ${icon('comment', true)}${video.commentCount} comments / ${timestamped} timestamped
      </p>
    </div>
  </li>`;
}

/** Channel switcher dropdown for the top app bar. */
function channelSwitcher(channels: Array<{ id: string; title: string }>, currentId?: string): Html {
  if (channels.length === 0) {
    return html`<nav class="channel-switcher">
      <label class="sr-only" for="channel-switcher">Channel</label>
      <select id="channel-switcher" disabled>
        <option>—</option>
      </select>
      ${icon('dropDown')}
    </nav>`;
  }
  const options = channels.map((ch) =>
    ch.id === currentId
      ? html`<option value="${ch.id}" selected>${ch.title}</option>`
      : html`<option value="${ch.id}">${ch.title}</option>`,
  );
  return html`<nav class="channel-switcher">
    <label class="sr-only" for="channel-switcher">Channel</label>
    <select id="channel-switcher">
      <option value="">Switch channel</option>
      ${options}
    </select>
    ${icon('dropDown')}
  </nav>`;
}

/** Render the current ingest status for an unlocked operator. */
function statusBlock(status: IngestRequest | null): Html {
  if (status === null) {
    return html`<div class="status" id="ingest-status"><p>No ingest requests yet.</p></div>`;
  }
  const counts = `${status.videosWritten} videos / ${status.commentsWritten} comments`;
  const active = status.status === 'queued' || status.status === 'running';
  const errorBlock =
    status.status === 'failed' && status.error
      ? html`<p class="ingest-error">${status.error}</p>`
      : '';
  return html`<div class="status" id="ingest-status">
    <span class="status-badge status-${status.status}">${status.status}</span>
    <span>${counts}</span>
    <span>updated ${relativeDate(status.updatedAt)}</span>
    ${active ? html`<div class="progress" role="progressbar" aria-label="Ingest in progress"></div>` : ''}
    ${errorBlock}
  </div>`;
}

/** The trigger form shown to an unlocked operator. */
function compactTriggerForm(): Html {
  return html`<form id="ingest-trigger-form" class="inline-form" aria-label="Trigger ingest">
      <label class="sr-only" for="ingest-channel">Channel</label>
      <input
        id="ingest-channel"
        class="text-field"
        type="text"
        name="channel"
        placeholder="@handle, channel ID, or youtube.com URL"
        required
      />
      <button class="btn btn-filled" type="submit">${icon('bolt', true)}Ingest</button>
    </form>
    <p id="ingest-shape-error" class="shape-error">
      Enter a YouTube handle (@name), channel ID (UC…), or youtube.com channel URL.
    </p>`;
}

/** The hero trigger form shown when no channels exist yet. */
function heroTriggerForm(): Html {
  return html`<div class="hero">
    <h2>Paste a channel to ingest</h2>
    <p class="hint">
      Videos and their timestamped comments will appear here once the run finishes.
    </p>
    ${compactTriggerForm()}
  </div>`;
}

/**
 * OperatorKey controls (ADR-0007, F6 #51): an optional key field kept in
 * this browser next to the operator token, a "Check key" probe, "Forget key",
 * and the live-chat opt-in (ADR-0009) sent with the trigger.
 */
function operatorKeyBlock(): Html {
  return html`<div class="operator-key" id="operator-key-block">
    <label for="operator-key"
      >Your YouTube Data API key (optional: the Ingest uses your quota)</label
    >
    <p class="inline-form">
      <input
        id="operator-key"
        class="text-field"
        type="password"
        placeholder="AIza… (leave empty to use the repository key)"
        autocomplete="off"
        spellcheck="false"
      />
      <button id="operator-key-check" class="btn btn-tonal" type="button">Check key</button>
      <button id="operator-key-forget" class="btn btn-text" type="button">Forget key</button>
    </p>
    <p id="operator-key-verdict" class="key-verdict" role="status" aria-live="polite"></p>
    <label class="checkbox-row" for="ingest-capture-live-chat">
      <input id="ingest-capture-live-chat" type="checkbox" name="captureLiveChat" />
      Capture live chat
    </label>
  </div>`;
}

/**
 * The operator surface (ADR-0005): a token form revealed from the top app
 * bar's key button while locked, and the trigger + status card once unlocked.
 */
function operatorSection(isEmpty: boolean, status: IngestRequest | null): Html {
  return html`<section class="operator-section" aria-label="Operator tools">
    <div class="visitor-only" id="operator-locked">
      <div id="operator-token-form" class="card operator-card" style="display:none">
        <h2>${icon('key', true)}Operator tools</h2>
        <p class="hint">Paste the operator token to trigger an Ingest from this browser.</p>
        <p class="inline-form">
          <label class="sr-only" for="operator-token">Operator token</label>
          <input
            id="operator-token"
            class="text-field"
            type="password"
            placeholder="Operator token"
            autocomplete="off"
          />
          <button id="operator-unlock" class="btn btn-filled" type="button">Save token</button>
        </p>
      </div>
    </div>
    <div class="operator-only card operator-card" id="operator-unlocked">
      ${
        isEmpty
          ? heroTriggerForm()
          : html`<h2>${icon('bolt', true)}Trigger ingest</h2>
              ${compactTriggerForm()}`
      }
      ${operatorKeyBlock()} ${statusBlock(status)}
      <div class="operator-footer">
        <button id="operator-forget" class="btn btn-text" type="button">
          ${icon('logout', true)}Forget token
        </button>
      </div>
    </div>
  </section>`;
}

/** The key button in the top app bar that reveals the operator token form. */
function operatorToggle(): Html {
  return html`<button
    id="operator-unlock-reveal"
    class="icon-btn"
    type="button"
    title="Unlock operator tools"
    aria-label="Unlock operator tools"
    aria-pressed="false"
  >
    ${icon('key')}
  </button>`;
}

/** Catalog search: filter the grid by title as the visitor types (`/` focuses it). */
function searchScript(): string {
  return `(function() {
  var input = document.getElementById('video-search');
  var cards = document.querySelectorAll('.video-card');
  var none = document.getElementById('no-results');
  if (!input) return;
  input.addEventListener('input', function() {
    var q = input.value.trim().toLowerCase();
    var shown = 0;
    cards.forEach(function(card) {
      var match = !q || (card.getAttribute('data-title') || '').indexOf(q) !== -1;
      card.hidden = !match;
      if (match) shown++;
    });
    if (none) none.hidden = shown !== 0;
  });
  document.addEventListener('keydown', function(e) {
    var t = e.target;
    if (e.key === '/' && t && t.tagName !== 'INPUT' && t.tagName !== 'TEXTAREA') {
      e.preventDefault();
      input.focus();
    }
  });
})();`;
}

/** The small inline script that gates operator chrome and polls status. */
function operatorScript(): string {
  return `(function() {
  var STORAGE_KEY = 'ytb_index_operator_token';
  var KEY_STORAGE_KEY = 'ytb_index_operator_key';
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
  var snackbar = document.getElementById('snackbar');
  var keyInput = document.getElementById('operator-key');
  var keyCheckBtn = document.getElementById('operator-key-check');
  var keyForgetBtn = document.getElementById('operator-key-forget');
  var keyVerdict = document.getElementById('operator-key-verdict');
  var liveChatBox = document.getElementById('ingest-capture-live-chat');
  var pollTimer = null;
  var snackTimer = null;

  // Storage can throw (private mode, blocked site data): treat it as empty.
  function storeGet(name) { try { return localStorage.getItem(name); } catch (e) { return null; } }
  function storeSet(name, value) { try { localStorage.setItem(name, value); } catch (e) {} }
  function storeRemove(name) { try { localStorage.removeItem(name); } catch (e) {} }

  function hasToken() { return !!storeGet(STORAGE_KEY); }

  // The OperatorKey (ADR-0007): the typed value wins over the stored one.
  function currentKey() {
    var typed = keyInput ? keyInput.value.trim() : '';
    return typed || storeGet(KEY_STORAGE_KEY) || '';
  }

  function showVerdict(message, ok) {
    if (!keyVerdict) return;
    keyVerdict.textContent = message || '';
    keyVerdict.classList.toggle('is-ok', ok === true);
    keyVerdict.classList.toggle('is-error', ok === false);
  }

  function notify(message) {
    if (!snackbar) return;
    snackbar.textContent = message;
    snackbar.classList.add('open');
    if (snackTimer) clearTimeout(snackTimer);
    snackTimer = setTimeout(function() { snackbar.classList.remove('open'); }, 5000);
  }

  function setOperatorVisible(show) {
    if (locked) locked.style.display = show ? 'none' : 'block';
    if (unlocked) unlocked.style.display = show ? 'grid' : 'none';
    if (revealBtn) revealBtn.style.display = show ? 'none' : '';
    document.body.classList.toggle('is-operator', show);
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
    var status = escapeHtml(data.status);
    var html = '<span class="status-badge status-' + status + '">' + status + '</span>' +
      '<span>' + (data.videosWritten || 0) + ' videos / ' + (data.commentsWritten || 0) + ' comments</span>' +
      '<span>updated ' + escapeHtml(new Date(data.updatedAt).toLocaleString()) + '</span>';
    if (data.status === 'queued' || data.status === 'running') {
      html += '<div class="progress" role="progressbar" aria-label="Ingest in progress"></div>';
    }
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
      var open = tokenForm.style.display === 'none';
      tokenForm.style.display = open ? 'grid' : 'none';
      revealBtn.setAttribute('aria-pressed', open ? 'true' : 'false');
      if (open && tokenInput) tokenInput.focus();
    });
  }

  function unlock() {
    var value = tokenInput.value.trim();
    if (value) {
      storeSet(STORAGE_KEY, value);
      setOperatorVisible(true);
      startPolling();
      notify('Operator tools unlocked.');
    }
  }

  if (unlockBtn && tokenInput) {
    unlockBtn.addEventListener('click', unlock);
    tokenInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') { e.preventDefault(); unlock(); }
    });
  }

  if (forgetBtn) {
    forgetBtn.addEventListener('click', function() {
      storeRemove(STORAGE_KEY);
      storeRemove(KEY_STORAGE_KEY);
      if (keyInput) keyInput.value = '';
      showVerdict('');
      setOperatorVisible(false);
      if (tokenForm) tokenForm.style.display = 'none';
      if (revealBtn) revealBtn.setAttribute('aria-pressed', 'false');
      if (tokenInput) tokenInput.value = '';
      notify('Operator token forgotten.');
    });
  }

  if (keyInput) keyInput.value = storeGet(KEY_STORAGE_KEY) || '';

  if (keyCheckBtn && keyInput) {
    keyCheckBtn.addEventListener('click', async function() {
      var key = keyInput.value.trim();
      var token = storeGet(STORAGE_KEY);
      if (!key) { showVerdict('Paste a YouTube Data API key first.', false); return; }
      if (!token) return;
      showVerdict('Checking key...');
      try {
        var res = await fetch('/api/key/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: JSON.stringify({ key: key })
        });
        if (res.status === 401) { showVerdict('Invalid operator token.', false); return; }
        if (!res.ok) { showVerdict('Key check failed: ' + res.status, false); return; }
        var verdict = await res.json();
        if (verdict.ok) {
          storeSet(KEY_STORAGE_KEY, key);
          showVerdict('Key works. Ingests from this browser will use your quota.', true);
        } else {
          showVerdict(verdict.message || 'Key refused.', false);
        }
      } catch (err) {
        showVerdict('Network error: ' + (err && err.message ? err.message : err), false);
      }
    });
  }

  if (keyForgetBtn) {
    keyForgetBtn.addEventListener('click', function() {
      storeRemove(KEY_STORAGE_KEY);
      if (keyInput) keyInput.value = '';
      showVerdict('Key forgotten. Ingests will use the repository key.');
    });
  }

  if (triggerForm && channelInput) {
    triggerForm.addEventListener('submit', async function(e) {
      e.preventDefault();
      var value = channelInput.value.trim();
      if (!looksLikeChannel(value)) {
        if (shapeError) shapeError.style.display = 'block';
        return;
      }
      if (shapeError) shapeError.style.display = 'none';
      var token = storeGet(STORAGE_KEY);
      if (!token) return;
      var payload = { channel: value, captureLiveChat: !!(liveChatBox && liveChatBox.checked) };
      var key = currentKey();
      if (key) payload.key = key;
      try {
        var res = await fetch('/api/ingest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: JSON.stringify(payload)
        });
        if (res.status === 401) { notify('Invalid operator token.'); return; }
        if (res.status === 422 || res.status === 503) {
          var refusal = await res.json().catch(function() { return {}; });
          var message = refusal.message || refusal.error || ('Ingest request failed: ' + res.status);
          showVerdict(message, false);
          notify(message);
          return;
        }
        if (res.status === 409) {
          var body = await res.json().catch(function() { return {}; });
          notify('An ingest is already running for this channel. Request: ' + (body.requestId || 'unknown'));
          startPolling();
          return;
        }
        if (!res.ok) { notify('Ingest request failed: ' + res.status); return; }
        channelInput.value = '';
        if (key) storeSet(KEY_STORAGE_KEY, key);
        notify('Ingest queued for ' + value + (key ? ' with your key.' : '.'));
        startPolling();
      } catch (err) {
        notify('Network error: ' + (err && err.message ? err.message : err));
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
}

/** Inline one or more script sources in a single `<script>` element. */
function inlineScript(...sources: string[]): Html {
  return html`<script>
    ${raw(sources.join('\n'))};
  </script>`;
}

/** The channel header: avatar, title, and the stats line with "Last refreshed". */
function channelHeader(channel: Channel, videos: CatalogVideo[]): Html {
  const timestamped = videos.reduce((sum, video) => sum + (video.timestampedCount ?? 0), 0);
  return html`<header class="channel-header">
    ${avatar(channel.title, true)}
    <div>
      <h1>${channel.title}</h1>
      <p class="channel-stats">
        <span>${videos.length} ${videos.length === 1 ? 'video' : 'videos'}</span>
        <span>${timestamped} timestamped comments</span>
        <span class="last-refreshed">Last refreshed: ${channel.fetchedAt.slice(0, 10)}</span>
      </p>
    </div>
  </header>`;
}

/** The empty-state block shared by every "nothing here yet" render. */
export function emptyState(iconName: IconName, title: Html | string, hint?: Html): Html {
  return html`<div class="empty-state">
    ${icon(iconName)}
    <h2>${title}</h2>
    ${hint ?? ''}
  </div>`;
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
  const title = channel === null ? 'ytb-index' : `${channel.title} — ytb-index`;
  const isEmpty = channel === null;

  let content: Html;
  if (isEmpty) {
    content = html`<div class="visitor-only">
      ${emptyState('library', 'No channels ingested yet.')}
    </div>`;
  } else if (videos.length === 0) {
    content = html`${channelHeader(channel, videos)}
    ${emptyState(
      'library',
      'No videos ingested.',
      html`<p>Run <code>pnpm ingest &lt;channel&gt;</code> to populate.</p>`,
    )}`;
  } else {
    content = html`${channelHeader(channel, videos)}
      <nav class="section-tabs" aria-label="Channel sections"><span>Videos</span></nav>
      <ul class="catalog">
        ${videos.map((video) => catalogRow(video))}
      </ul>
      <p id="no-results" class="no-results" hidden>No videos match your search.</p>`;
  }

  return page(title, html`${operatorSection(isEmpty, status)}${content}`, {
    search: !isEmpty && videos.length > 0,
    actions: html`${channelSwitcher(channels, channel?.id)}${operatorToggle()}`,
    scripts: inlineScript(searchScript(), operatorScript()),
  });
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
  const classes = ['comment'];
  if (anchors.length > 0) classes.push('timestamped');
  if (comment.isExpired === true) classes.push('expired');
  return html`<li class="${classes.join(' ')}">
    ${avatar(comment.author)}
    <div class="comment-content">
      <p class="comment-meta">
        <span class="author">${comment.author}</span>
        <time datetime="${comment.publishedAt}">${relativeDate(comment.publishedAt)}</time>
      </p>
      <p class="comment-body">${linkifyAnchors(comment.text, anchors, videoId)}</p>
      ${timestampsFooter(videoId, anchors)}
      <p class="comment-actions">
        ${icon('thumbUp', true)}<span
          >${comment.likeCount > 0 ? formatCount(comment.likeCount) : ''}</span
        >
      </p>
    </div>
  </li>`;
}

/** The "Key moments" side panel: the offsets the comments cite most. */
function keyMomentsPanel(videoId: string, anchors: Anchor[]): Html | string {
  const moments = keyMoments(anchors);
  if (moments.length === 0) {
    return '';
  }
  const peak = Math.max(...moments.map((moment) => moment.comments));
  return html`<aside class="card moments" aria-labelledby="moments-title">
    <h2 id="moments-title">${icon('schedule', true)}Key moments</h2>
    <p class="hint">The timestamps commenters point to most often.</p>
    <ol class="moment-list">
      ${moments.map(
        (moment) =>
          html`<li>
            <a
              target="_blank"
              rel="noopener noreferrer"
              href="https://www.youtube.com/watch?v=${videoId}&t=${moment.seconds}s"
            >
              <span class="moment-time">${formatTimestamp(moment.seconds)}</span>
              <span class="moment-bar"
                ><span style="width: ${Math.round((moment.comments / peak) * 100)}%"></span
              ></span>
              <span class="moment-count"
                >${moment.comments} ${moment.comments === 1 ? 'comment' : 'comments'}</span
              >
            </a>
          </li>`,
      )}
    </ol>
  </aside>`;
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
  const timestampedCount = comments.filter((comment) => anchorsByComment.has(comment.id)).length;

  const commentList =
    comments.length === 0
      ? emptyState('forum', 'No comments on this video.')
      : html`<div class="chip-row" role="radiogroup" aria-label="Filter comments">
            <input type="radio" name="comment-filter" id="filter-all" checked />
            <label class="chip" for="filter-all"
              >All <span class="chip-count">${comments.length}</span></label
            >
            <input type="radio" name="comment-filter" id="filter-timestamped" />
            <label class="chip" for="filter-timestamped"
              >${icon('schedule', true)}Timestamped
              <span class="chip-count">${timestampedCount}</span></label
            >
          </div>
          <ul class="comments">
            ${comments.map((comment) =>
              commentItem(video.id, comment, anchorsByComment.get(comment.id) ?? []),
            )}
          </ul>`;

  const alt = video.title === '' ? 'Video thumbnail' : video.title;
  return page(
    `${video.title} — ytb-index`,
    html`<div class="watch">
      <div class="watch-main">
        <a
          class="player"
          target="_blank"
          rel="noopener noreferrer"
          href="https://www.youtube.com/watch?v=${video.id}"
          aria-label="Play on YouTube"
        >
          <img class="thumbnail" src="${video.thumbnailUrl}" alt="${alt}" width="640" />
          ${PLAY_BUTTON}
        </a>
        <header class="video-header">
          <h1>${video.title}</h1>
          <p class="published">
            <span>${formatCount(video.viewCount)} views</span>
            <time datetime="${video.publishedAt}">${relativeDate(video.publishedAt)}</time>
            <span>${formatCount(video.likeCount)} likes</span>
          </p>
          <div class="watch-actions">
            <a
              target="_blank"
              rel="noopener noreferrer"
              href="https://www.youtube.com/watch?v=${video.id}"
              >Watch on YouTube</a
            >
            <a class="btn btn-tonal back-link" href="/c/${video.channelId}"
              >${icon('arrowBack', true)}All videos</a
            >
          </div>
        </header>
        <section class="comments-section" aria-labelledby="comments-title">
          <h2 id="comments-title">${comments.length} Comments</h2>
          ${commentList}
        </section>
      </div>
      ${keyMomentsPanel(video.id, anchors)}
    </div>`,
  );
}

/** Render the shared `text/html` 404 page (`message` explains what was not found). */
export function renderNotFound(message: string): string {
  return page(
    'Not found — ytb-index',
    html`<div class="not-found">
      ${icon('library')}
      <h1>404 Not Found</h1>
      <p>${message}</p>
      <a class="btn btn-filled" href="/">Back to the catalog</a>
    </div>`,
  );
}
