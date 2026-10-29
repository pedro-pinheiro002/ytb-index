/**
 * The public `/search` page template (`server/search-page`): ticket F5 (#53),
 * ADR-0010, spec v2 "SearchQuery contract" and "SearchHit links".
 *
 * {@link renderSearch} turns the submitted params plus one of three states
 * (empty form, invalid params, a page of SearchHits) into a complete HTML
 * string inside the shared shell from `./ssr.tsx`. The form is a plain GET
 * form, so a SearchQuery is a bookmarkable URL and the page works without
 * JavaScript. Every value goes through Hono's `html` helper, which escapes
 * it; matched terms are marked by slicing the original text at the offsets
 * `./highlight.ts` computes and interpolating each slice, so record text is
 * never injected as markup.
 *
 * Pure and side-effect free: no database, no clock beyond `relativeDate`.
 */
import { html } from 'hono/html';
import { DEFAULT_SEARCH_KINDS, type SearchPage } from '../db/catalog-search.ts';
import type { SearchHit, SearchHitKind, SearchSort } from '../shared/types.ts';
import { matchRanges } from './highlight.ts';
import { emptyState, formatCount, formatTimestamp, icon, page, relativeDate } from './ssr.tsx';
import type { Html } from './ssr.tsx';

/** A Channel the form's Channel select offers. */
export interface SearchChannelOption {
  id: string;
  title: string;
}

/** What the `/search` page shows below the form. */
export type SearchPageState =
  | { type: 'empty' }
  | { type: 'invalid'; errors: string[] }
  | { type: 'results'; terms: string[]; result: SearchPage };

/** Everything {@link renderSearch} needs. */
export interface SearchPageModel {
  /** The submitted `GET /search` params, echoed back into the form and pagination. */
  params: URLSearchParams;
  /** Channels for the Channel select. */
  channels: SearchChannelOption[];
  state: SearchPageState;
}

/** Longest snippet shown for one SearchHit, in UTF-16 units. */
const SNIPPET_MAX = 280;
/** Context kept before the first match when a snippet is cut. */
const SNIPPET_LEAD = 60;

const KIND_LABELS: Record<SearchHitKind, string> = {
  comment: 'Comment',
  reply: 'Reply',
  chat: 'Live chat',
  video: 'Video',
};

const SORT_LABELS: Record<SearchSort, string> = {
  newest: 'Newest',
  oldest: 'Oldest',
  likes: 'Most liked',
};

const WATCH = 'https://www.youtube.com/watch?v=';

/** Move `index` off the low half of a surrogate pair. */
function codePointBoundary(text: string, index: number): number {
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff ? index + 1 : index;
}

/**
 * The hit text with every term match wrapped in `<mark>`, cut to a window
 * around the first match when the text is long. Slices are escaped by the
 * `html` helper; only the `<mark>` tags are markup.
 */
function highlightSnippet(text: string, terms: readonly string[]): Html {
  const ranges = matchRanges(text, terms);
  let start = 0;
  let end = text.length;
  if (text.length > SNIPPET_MAX) {
    const first = ranges[0]?.start ?? 0;
    start = codePointBoundary(text, Math.max(0, Math.min(first - SNIPPET_LEAD, end - SNIPPET_MAX)));
    end = codePointBoundary(text, Math.min(text.length, start + SNIPPET_MAX));
  }

  const parts: Html[] = [];
  let cursor = start;
  for (const range of ranges) {
    const from = Math.max(range.start, cursor);
    const to = Math.min(range.end, end);
    if (from >= to) continue;
    parts.push(html`${text.slice(cursor, from)}<mark>${text.slice(from, to)}</mark>`);
    cursor = to;
  }
  parts.push(html`${text.slice(cursor, end)}`);
  return html`${start > 0 ? '…' : ''}${parts}${end < text.length ? '…' : ''}`;
}

/** The hit's place in the app's video page. */
function appHref(hit: SearchHit): string {
  const video = `/v/${encodeURIComponent(hit.videoId)}`;
  const record = encodeURIComponent(hit.recordId);
  switch (hit.kind) {
    case 'comment':
    case 'reply':
      return `${video}#c-${record}`;
    case 'chat':
      return `${video}#m-${record}`;
    case 'video':
      return video;
  }
}

/** The hit's YouTube link: at the first anchor, the offset, or the comment. */
function youtubeHref(hit: SearchHit): string {
  const watch = `${WATCH}${encodeURIComponent(hit.videoId)}`;
  const firstAnchor = hit.anchorSeconds[0];
  switch (hit.kind) {
    case 'comment':
    case 'reply':
      return firstAnchor !== undefined
        ? `${watch}&t=${firstAnchor}s`
        : `${watch}&lc=${encodeURIComponent(hit.recordId)}`;
    case 'chat':
      return hit.offsetSeconds === null ? watch : `${watch}&t=${hit.offsetSeconds}s`;
    case 'video':
      return watch;
  }
}

/** One external link, opened safely in a new tab (v1 §6). */
function externalLink(href: string, label: Html | string, className = ''): Html {
  return html`<a
    ${className === '' ? '' : html`class="${className}"`}
    href="${href}"
    target="_blank"
    rel="noopener noreferrer"
    >${label}</a
  >`;
}

/** The per-anchor jump links of a comment or Reply hit. */
function anchorLinks(hit: SearchHit): Html | string {
  if (hit.anchorSeconds.length === 0) return '';
  const watch = `${WATCH}${encodeURIComponent(hit.videoId)}`;
  return html`<p class="timestamps">
    Timestamps:
    ${hit.anchorSeconds.map(
      (seconds, index) =>
        html`${index > 0 ? ' · ' : ''}${externalLink(
          `${watch}&t=${seconds}s`,
          formatTimestamp(seconds),
        )}`,
    )}
  </p>`;
}

/** Author, date, likes and (for a Reply) whose comment it answers. */
function hitByline(hit: SearchHit): Html {
  const reply =
    hit.kind === 'reply' && hit.parentAuthor !== undefined && hit.parentAuthor !== null
      ? html`<span>Reply to <span class="author">${hit.parentAuthor}</span></span>`
      : '';
  const offset =
    hit.kind === 'chat' && hit.offsetSeconds !== null
      ? html`<span>at ${formatTimestamp(hit.offsetSeconds)}</span>`
      : '';
  return html`<p class="search-hit-byline">
    ${hit.author === '' ? '' : html`<span class="author">${hit.author}</span>`} ${reply}
    <time datetime="${hit.publishedAt}" title="${hit.publishedAt.slice(0, 10)}"
      >${relativeDate(hit.publishedAt)}</time
    >
    ${offset}
    ${
      hit.likeCount > 0
        ? html`<span class="search-hit-likes"
            >${icon('thumbUp', true)}${formatCount(hit.likeCount)}</span
          >`
        : ''
    }
  </p>`;
}

/** One SearchHit card: kind, video, byline, highlighted snippet, links. */
function hitItem(hit: SearchHit, terms: readonly string[]): Html {
  return html`<li class="search-hit card">
    <p class="search-hit-meta">
      <span class="search-kind search-kind-${hit.kind}">${KIND_LABELS[hit.kind]}</span>
      <a class="search-hit-video" href="${appHref(hit)}">${hit.videoTitle}</a>
    </p>
    ${hitByline(hit)}
    <p class="search-hit-snippet">${highlightSnippet(hit.text, terms)}</p>
    ${anchorLinks(hit)}
    <p class="search-hit-links">
      <a class="btn btn-text" href="${appHref(hit)}">Open in ytb-index</a>
      ${externalLink(youtubeHref(hit), 'Watch on YouTube', 'btn btn-text')}
    </p>
  </li>`;
}

/** `/search?…` with every submitted param kept and `page` replaced. */
function pageHref(params: URLSearchParams, target: number): string {
  const next = new URLSearchParams(params);
  next.set('page', String(target));
  return `/search?${next.toString()}`;
}

/** Prev / next links; each only when that page can exist. */
function pagination(params: URLSearchParams, result: SearchPage): Html | string {
  const prev =
    result.page > 1
      ? html`<a class="btn btn-outlined" rel="prev" href="${pageHref(params, result.page - 1)}"
          >Previous</a
        >`
      : '';
  const next = result.hasNextPage
    ? html`<a class="btn btn-outlined" rel="next" href="${pageHref(params, result.page + 1)}"
        >Next</a
      >`
    : '';
  if (prev === '' && next === '') return '';
  return html`<nav class="search-pagination" aria-label="Pages">
    ${prev}<span>Page ${result.page}</span>${next}
  </nav>`;
}

function value(params: URLSearchParams, name: string): string {
  return params.get(name) ?? '';
}

function dateField(params: URLSearchParams, name: string, label: string): Html {
  return html`<label class="search-filter"
    ><span>${label}</span
    ><input class="text-field" type="date" name="${name}" value="${value(params, name)}"
  /></label>`;
}

/** The GET form, pre-filled with the submitted params. */
function searchForm(params: URLSearchParams, channels: SearchChannelOption[]): Html {
  const submittedKinds = params.getAll('kind');
  const checkedKinds: readonly string[] =
    submittedKinds.length > 0 ? submittedKinds : DEFAULT_SEARCH_KINDS;
  const channel = value(params, 'channel');
  const sort = value(params, 'sort') || 'newest';
  const kinds: SearchHitKind[] = ['comment', 'reply', 'chat', 'video'];
  const sorts: SearchSort[] = ['newest', 'oldest', 'likes'];

  return html`<form class="search-form card" method="get" action="/search" role="search">
    <div class="search-row">
      <label class="sr-only" for="search-q">Terms</label>
      <input
        id="search-q"
        class="text-field"
        type="search"
        name="q"
        value="${value(params, 'q')}"
        placeholder="Search comments, Replies, live chat and videos"
      />
      <button class="btn btn-filled" type="submit">${icon('search', true)}Search</button>
    </div>
    <fieldset class="chip-row">
      <legend class="sr-only">Record kinds</legend>
      ${kinds.map(
        (kind) =>
          html`<label
            ><input
              type="checkbox"
              name="kind"
              value="${kind}"
              ${checkedKinds.includes(kind) ? 'checked' : ''}
            /><span class="chip">${KIND_LABELS[kind]}</span></label
          >`,
      )}
      <label
        ><input
          type="checkbox"
          name="timestamped"
          value="1"
          ${value(params, 'timestamped') === '1' ? 'checked' : ''}
        /><span class="chip">${icon('schedule', true)}Timestamped only</span></label
      >
    </fieldset>
    <div class="search-filters">
      <label class="search-filter"
        ><span>Channel</span
        ><select class="text-field" name="channel">
          <option value="">All channels</option>
          ${channels.map(
            (option) =>
              html`<option value="${option.id}" ${option.id === channel ? 'selected' : ''}>
                ${option.title}
              </option>`,
          )}
        </select></label
      >
      <label class="search-filter"
        ><span>Author</span
        ><input
          class="text-field"
          type="text"
          name="author"
          value="${value(params, 'author')}"
          placeholder="Name or UC… id"
      /></label>
      ${dateField(params, 'from', 'Written from')} ${dateField(params, 'to', 'Written to')}
      ${dateField(params, 'videoFrom', 'Video from')} ${dateField(params, 'videoTo', 'Video to')}
      <label class="search-filter"
        ><span>Sort</span
        ><select class="text-field" name="sort">
          ${sorts.map(
            (option) =>
              html`<option value="${option}" ${option === sort ? 'selected' : ''}>
                ${SORT_LABELS[option]}
              </option>`,
          )}
        </select></label
      >
    </div>
  </form>`;
}

/** What goes under the form for each state. */
function stateBody(params: URLSearchParams, state: SearchPageState): Html {
  switch (state.type) {
    case 'empty':
      return emptyState(
        'search',
        'Search the Catalog',
        html`<p>
          Enter terms, an author or a date range to search comments, Replies and live chat.
        </p>`,
      );
    case 'invalid':
      return html`<div class="search-errors" role="alert">
        <h2>Check your search</h2>
        <ul>
          ${state.errors.map((error) => html`<li>${error}</li>`)}
        </ul>
      </div>`;
    case 'results':
      if (state.result.hits.length === 0) {
        return emptyState(
          'search',
          'Nothing in the Catalog matches this search.',
          html`<p>Try fewer terms, another record kind or a wider date range.</p>`,
        );
      }
      return html`<ol class="search-hits">
          ${state.result.hits.map((hit) => hitItem(hit, state.terms))}
        </ol>
        ${pagination(params, state.result)}`;
  }
}

/**
 * Render the `/search` page: the GET form, then the empty state, the inline
 * errors (the route answers those with HTTP 400) or one page of SearchHits.
 */
export function renderSearch(model: SearchPageModel): string {
  const q = value(model.params, 'q').trim();
  const title = q === '' ? 'Search — ytb-index' : `${q} — Search — ytb-index`;
  return page(
    title,
    html`<section class="search-page" aria-labelledby="search-title">
      <h1 id="search-title">Search</h1>
      ${searchForm(model.params, model.channels)} ${stateBody(model.params, model.state)}
    </section>`,
  );
}
