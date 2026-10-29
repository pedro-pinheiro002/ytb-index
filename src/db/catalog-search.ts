/**
 * Catalog search (`db/catalog-search`): ticket F4 (#50), ADR-0010, spec v2
 * "SearchQuery contract".
 *
 * Owns the SearchQuery read path over the Catalog only (never YouTube):
 *
 * - {@link parseSearchQuery}: pure validation of `GET /search` params into a
 *   {@link SearchQuery}, or a list of human-readable errors (the page renders
 *   them inline with HTTP 400, never a 500).
 * - {@link isEmptySearch}: whether a query has nothing to search by, in which
 *   case the page shows only the form.
 * - {@link searchCatalog}: one ordered, offset-paginated page of SearchHits.
 *   Each requested kind (comment, Reply, LiveChatMessage, video) is one
 *   branch of a `UNION ALL`; every branch is built with `./filter.ts`, so
 *   every value is a bound `?` param and the SQL runs unchanged on
 *   better-sqlite3 and D1.
 *
 * Terms are matched as ADR-0010 prescribes: each normalized term becomes
 * `search_text LIKE '%' || ? || '%' ESCAPE '\'`, ANDed. TTL (ADR-0001):
 * CommentRecords and LiveChatMessages are read only through
 * `comments_active` / `live_chat_messages_active` and every such branch also
 * requires `is_expired = 0`, so expired rows neither match a term nor come
 * back from a term-less (author- or date-only) search.
 */
import type { SearchHit, SearchHitKind, SearchQuery, SearchSort } from '../shared/types.ts';
import type { Executor } from './executor.ts';
import { buildQuery, type BuiltQuery, type Predicate, type SqlValue } from './filter.ts';
import { normalizeSearchText } from './search-text.ts';

// ---------------------------------------------------------------------------
// Contract constants
// ---------------------------------------------------------------------------

/** SearchHits per page (spec v2). */
export const SEARCH_PAGE_SIZE = 25;

/** Highest page a SearchQuery may ask for (spec v2). */
export const SEARCH_MAX_PAGE = 40;

/** Most terms a SearchQuery may carry (spec v2). */
export const SEARCH_MAX_TERMS = 8;

/** Fewest characters (code points) in one normalized term (spec v2). */
export const SEARCH_MIN_TERM_LENGTH = 2;

/** Kinds searched when the query names none (spec v2). */
export const DEFAULT_SEARCH_KINDS: readonly SearchHitKind[] = ['comment', 'reply', 'chat'];

const KINDS: readonly SearchHitKind[] = ['comment', 'reply', 'chat', 'video'];
const SORTS: readonly SearchSort[] = ['newest', 'oldest', 'likes'];

/** A YouTube channel id: `UC` + 22 id characters (24 in all). */
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Raw `GET /search` params: a `URLSearchParams` or a (multi-)value record. */
export type SearchParams =
  URLSearchParams | Readonly<Record<string, string | string[] | undefined>>;

/** Outcome of {@link parseSearchQuery}. */
export type ParsedSearchQuery = { ok: true; query: SearchQuery } | { ok: false; errors: string[] };

function valuesOf(params: SearchParams, name: string): string[] {
  const raw =
    params instanceof URLSearchParams
      ? params.getAll(name)
      : ((): string[] => {
          const value = params[name];
          if (value === undefined) return [];
          return typeof value === 'string' ? [value] : value;
        })();
  return raw.map((value) => value.trim()).filter((value) => value !== '');
}

/** First non-empty value of a single-valued param, or `null`. */
function firstOf(params: SearchParams, name: string): string | null {
  return valuesOf(params, name)[0] ?? null;
}

function isDay(value: string): boolean {
  if (!DAY.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function parseDay(params: SearchParams, name: string, errors: string[]): string | null {
  const value = firstOf(params, name);
  if (value === null) return null;
  if (!isDay(value)) {
    errors.push(`${name}: expected a date as YYYY-MM-DD, got ${JSON.stringify(value)}`);
    return null;
  }
  return value;
}

/**
 * Validate `GET /search` params against the spec v2 SearchQuery contract.
 * Pure: no I/O, no clock. Empty values (an untouched GET form field) count
 * as absent; for single-valued params the first non-empty value wins.
 *
 * - `q`: split on whitespace, each piece normalized with
 *   `normalizeSearchText`; pieces that normalize to `''` are dropped. At most
 *   8 terms, each at least 2 characters once normalized.
 * - `kind` (repeatable): `comment`, `reply`, `chat`, `video`; deduplicated;
 *   default `comment`, `reply`, `chat`.
 * - `channel`: a `UC…` channel id.
 * - `from`, `to`, `videoFrom`, `videoTo`: real `YYYY-MM-DD` days, each range
 *   ordered (`from <= to`).
 * - `author`: a `UC…` id is kept verbatim (exact `authorChannelId`);
 *   anything else is normalized (display-name substring) and must not
 *   normalize to `''`.
 * - `timestamped`: `1` (on) or `0` (off).
 * - `sort`: `newest` (default), `oldest`, `likes`.
 * - `page`: an integer from 1 to 40; default 1.
 *
 * @returns The validated query, or every error found (never throws).
 */
export function parseSearchQuery(params: SearchParams): ParsedSearchQuery {
  const errors: string[] = [];

  const terms: string[] = [];
  for (const piece of valuesOf(params, 'q').join(' ').split(/\s+/)) {
    const term = normalizeSearchText(piece);
    if (term === '') continue;
    if ([...term].length < SEARCH_MIN_TERM_LENGTH) {
      errors.push(
        `q: each term needs at least ${SEARCH_MIN_TERM_LENGTH} characters, got ${JSON.stringify(piece)}`,
      );
      continue;
    }
    terms.push(term);
  }
  if (terms.length > SEARCH_MAX_TERMS) {
    errors.push(`q: at most ${SEARCH_MAX_TERMS} terms, got ${terms.length}`);
  }

  const kinds: SearchHitKind[] = [];
  for (const value of valuesOf(params, 'kind')) {
    const kind = KINDS.find((candidate) => candidate === value);
    if (kind === undefined) {
      errors.push(`kind: expected one of ${KINDS.join(', ')}, got ${JSON.stringify(value)}`);
    } else if (!kinds.includes(kind)) {
      kinds.push(kind);
    }
  }

  const channelId = firstOf(params, 'channel');
  if (channelId !== null && !CHANNEL_ID.test(channelId)) {
    errors.push(`channel: expected a UC… channel id, got ${JSON.stringify(channelId)}`);
  }

  const from = parseDay(params, 'from', errors);
  const to = parseDay(params, 'to', errors);
  if (from !== null && to !== null && from > to) errors.push('from: must not be after to');
  const videoFrom = parseDay(params, 'videoFrom', errors);
  const videoTo = parseDay(params, 'videoTo', errors);
  if (videoFrom !== null && videoTo !== null && videoFrom > videoTo) {
    errors.push('videoFrom: must not be after videoTo');
  }

  let author = firstOf(params, 'author');
  if (author !== null && !CHANNEL_ID.test(author)) {
    const normalized = normalizeSearchText(author);
    if (normalized === '')
      errors.push(`author: ${JSON.stringify(author)} has no letters or digits`);
    author = normalized;
  }

  const timestampedValue = firstOf(params, 'timestamped');
  if (timestampedValue !== null && timestampedValue !== '1' && timestampedValue !== '0') {
    errors.push(`timestamped: expected 1, got ${JSON.stringify(timestampedValue)}`);
  }

  const sortValue = firstOf(params, 'sort') ?? 'newest';
  const sort = SORTS.find((candidate) => candidate === sortValue);
  if (sort === undefined) {
    errors.push(`sort: expected one of ${SORTS.join(', ')}, got ${JSON.stringify(sortValue)}`);
  }

  const pageValue = firstOf(params, 'page') ?? '1';
  const page = /^\d+$/.test(pageValue) ? Number(pageValue) : Number.NaN;
  if (!Number.isSafeInteger(page) || page < 1 || page > SEARCH_MAX_PAGE) {
    errors.push(`page: expected an integer from 1 to ${SEARCH_MAX_PAGE}, got ${pageValue}`);
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    query: {
      terms,
      kinds: kinds.length > 0 ? kinds : [...DEFAULT_SEARCH_KINDS],
      channelId,
      from,
      to,
      videoFrom,
      videoTo,
      author: author === '' ? null : author,
      timestamped: timestampedValue === '1',
      sort: sort ?? 'newest',
      page,
    },
  };
}

/**
 * Whether `query` has nothing to search by: no terms, no author and no date
 * range (neither the hit's nor the video's). The `/search` page then shows
 * only the form, never the whole Catalog (spec v2), and
 * {@link searchCatalog} returns no hits without touching the database.
 */
export function isEmptySearch(query: SearchQuery): boolean {
  return (
    query.terms.length === 0 &&
    query.author === null &&
    query.from === null &&
    query.to === null &&
    query.videoFrom === null &&
    query.videoTo === null
  );
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** One page of SearchHits. */
export interface SearchPage {
  /** At most {@link SEARCH_PAGE_SIZE} hits, in the query's sort order. */
  hits: SearchHit[];
  /** Whether page `page + 1` has at least one hit. */
  hasNextPage: boolean;
  /** The 1-based page these hits are. */
  page: number;
}

/** The `UNION ALL` row shape; every branch selects these columns in order. */
interface HitRow {
  kind: SearchHitKind;
  video_id: string;
  video_title: string;
  record_id: string;
  author: string;
  author_channel_id: string;
  published_at: string;
  text: string;
  like_count: number;
  offset_seconds: number | null;
  parent_id: string | null;
  parent_author: string | null;
}

/**
 * Code-side orderings over the union's columns. Ties fall back to the record
 * id and then the kind, so pages never overlap or skip a hit.
 */
const ORDERINGS: Readonly<Record<SearchSort, string>> = {
  newest: 'published_at DESC, record_id DESC, kind DESC',
  oldest: 'published_at ASC, record_id ASC, kind ASC',
  likes: 'like_count DESC, published_at DESC, record_id DESC, kind DESC',
};

const COMMENT_SELECT = `
  SELECT ? AS kind, c.video_id AS video_id, v.title AS video_title, c.id AS record_id,
    c.author AS author, c.author_channel_id AS author_channel_id,
    c.published_at AS published_at, c.text AS text, c.like_count AS like_count,
    NULL AS offset_seconds, c.parent_id AS parent_id, p.author AS parent_author
  FROM comments_active c
  JOIN videos v ON v.id = c.video_id
  LEFT JOIN comments_active p ON p.id = c.parent_id
`;

const CHAT_SELECT = `
  SELECT 'chat' AS kind, m.video_id AS video_id, v.title AS video_title, m.id AS record_id,
    m.author AS author, m.author_channel_id AS author_channel_id,
    m.published_at AS published_at, m.text AS text, 0 AS like_count,
    m.offset_seconds AS offset_seconds, NULL AS parent_id, NULL AS parent_author
  FROM live_chat_messages_active m
  JOIN videos v ON v.id = m.video_id
`;

const VIDEO_SELECT = `
  SELECT 'video' AS kind, v.id AS video_id, v.title AS video_title, v.id AS record_id,
    '' AS author, '' AS author_channel_id,
    v.published_at AS published_at, CASE WHEN v.description = '' THEN v.title
      ELSE v.title || ' — ' || v.description END AS text, 0 AS like_count,
    NULL AS offset_seconds, NULL AS parent_id, NULL AS parent_author
  FROM videos v
`;

/** The day after a `YYYY-MM-DD` day, for an exclusive `< to + 1 day` bound. */
function nextDay(day: string): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/**
 * How the author filter applies: an exact `authorChannelId`, a resolved set
 * of display names, or none.
 */
type AuthorFilter =
  { by: 'none' } | { by: 'channelId'; value: string } | { by: 'names'; names: string[] };

/**
 * Predicates every branch shares, over its own alias: terms on
 * `search_text`, Channel scope, the hit's own date range on `published_at`
 * and the source video's date range on `v.published_at`.
 */
function commonPredicates(query: SearchQuery, alias: string, terms: string[]): Predicate[] {
  const where: Predicate[] = terms.map((term) => ({
    op: 'contains',
    column: `${alias}.search_text`,
    value: term,
  }));
  if (query.channelId !== null) {
    where.push({ op: 'eq', column: `${alias}.channel_id`, value: query.channelId });
  }
  if (query.from !== null) {
    where.push({ op: 'gte', column: `${alias}.published_at`, value: query.from });
  }
  if (query.to !== null) {
    where.push({ op: 'lt', column: `${alias}.published_at`, value: nextDay(query.to) });
  }
  if (query.videoFrom !== null) {
    where.push({ op: 'gte', column: 'v.published_at', value: query.videoFrom });
  }
  if (query.videoTo !== null) {
    where.push({ op: 'lt', column: 'v.published_at', value: nextDay(query.videoTo) });
  }
  return where;
}

function authorPredicates(author: AuthorFilter, alias: string): Predicate[] {
  switch (author.by) {
    case 'none':
      return [];
    case 'channelId':
      return [{ op: 'eq', column: `${alias}.author_channel_id`, value: author.value }];
    case 'names':
      return [{ op: 'inJson', column: `${alias}.author`, values: author.names }];
  }
}

/** One `UNION ALL` branch per requested kind that the filters allow. */
function branches(query: SearchQuery, terms: string[], author: AuthorFilter): BuiltQuery[] {
  const built: BuiltQuery[] = [];
  for (const kind of ['comment', 'reply'] as const) {
    if (!query.kinds.includes(kind)) continue;
    const where: Predicate[] = [
      { op: 'eq', column: 'c.is_expired', value: 0 },
      { op: kind === 'comment' ? 'isNull' : 'notNull', column: 'c.parent_id' },
      ...commonPredicates(query, 'c', terms),
      ...authorPredicates(author, 'c'),
    ];
    if (query.timestamped) where.push({ op: 'eq', column: 'c.has_anchors', value: 1 });
    const branch = buildQuery(COMMENT_SELECT, { where });
    built.push({ sql: branch.sql, params: [kind, ...branch.params] });
  }
  if (query.kinds.includes('chat')) {
    // Every LiveChatMessage has an offset, so `timestamped` keeps them all.
    const where: Predicate[] = [
      { op: 'eq', column: 'm.is_expired', value: 0 },
      ...commonPredicates(query, 'm', terms),
      ...authorPredicates(author, 'm'),
    ];
    built.push(buildQuery(CHAT_SELECT, { where }));
  }
  // A video has no author and no TimeAnchors: an author filter or
  // `timestamped` excludes video hits.
  if (query.kinds.includes('video') && author.by === 'none' && !query.timestamped) {
    built.push(buildQuery(VIDEO_SELECT, { where: commonPredicates(query, 'v', terms) }));
  }
  return built;
}

/**
 * Resolve a display-name author filter to the exact stored names it matches.
 *
 * Why not SQL: the spec asks for a *normalized* substring of the display
 * name (accents and case folded like `search_text`), but the schema has no
 * normalized author column and SQLite's `lower()` / `LIKE` fold ASCII only
 * (ADR-0010's reason for `search_text`), so `lower(author) LIKE ?` would miss
 * "João" for "joao". Why not a JS post-filter of the page: it would break
 * offset pagination and `hasNextPage`. So, without a migration: one extra
 * query reads the distinct live author names in scope (requested tables,
 * Channel), `normalizeSearchText` folds them in JS, and the matching raw
 * names go back into the main query as one JSON-array param
 * (`author IN (SELECT value FROM json_each(?))`), which stays under D1's
 * bound-parameter cap however many names match. Cost: a scan of the
 * Channel's author column, the same order as one term search (ADR-0010).
 */
async function resolveAuthorNames(
  executor: Executor,
  query: SearchQuery,
  needle: string,
): Promise<string[]> {
  const sources: Array<{ view: string; alias: string }> = [];
  if (query.kinds.includes('comment') || query.kinds.includes('reply')) {
    sources.push({ view: 'comments_active', alias: 'c' });
  }
  if (query.kinds.includes('chat')) sources.push({ view: 'live_chat_messages_active', alias: 'm' });

  const names = new Set<string>();
  for (const { view, alias } of sources) {
    const where: Predicate[] = [{ op: 'eq', column: `${alias}.is_expired`, value: 0 }];
    if (query.channelId !== null) {
      where.push({ op: 'eq', column: `${alias}.channel_id`, value: query.channelId });
    }
    const { sql, params } = buildQuery(
      `SELECT DISTINCT ${alias}.author AS author FROM ${view} ${alias}`,
      {
        where,
      },
    );
    for (const row of await executor.all<{ author: string }>(sql, params)) {
      if (normalizeSearchText(row.author).includes(needle)) names.add(row.author);
    }
  }
  return [...names].sort();
}

/** TimeAnchor seconds per comment id, in text order, in one query. */
async function loadAnchorSeconds(
  executor: Executor,
  commentIds: string[],
): Promise<Map<string, number[]>> {
  const anchors = new Map<string, number[]>();
  if (commentIds.length === 0) return anchors;
  const { sql, params } = buildQuery('SELECT comment_id, seconds FROM time_anchors', {
    where: [{ op: 'in', column: 'comment_id', values: commentIds }],
    order: { by: 'text', orderings: { text: 'comment_id ASC, char_position ASC' } },
  });
  for (const row of await executor.all<{ comment_id: string; seconds: number }>(sql, params)) {
    const list = anchors.get(row.comment_id) ?? [];
    list.push(Number(row.seconds));
    anchors.set(row.comment_id, list);
  }
  return anchors;
}

function toSearchHit(row: HitRow, anchors: Map<string, number[]>): SearchHit {
  const isComment = row.kind === 'comment' || row.kind === 'reply';
  return {
    kind: row.kind,
    videoId: row.video_id,
    videoTitle: row.video_title,
    recordId: row.record_id,
    author: row.author,
    authorChannelId: row.author_channel_id,
    publishedAt: row.published_at,
    text: row.text,
    likeCount: Number(row.like_count),
    anchorSeconds: isComment ? (anchors.get(row.record_id) ?? []) : [],
    offsetSeconds: row.offset_seconds === null ? null : Number(row.offset_seconds),
    parentId: row.parent_id,
    parentAuthor: row.parent_author,
  };
}

/**
 * Run a validated SearchQuery over the Catalog and return one page of
 * SearchHits (spec v2 "SearchQuery contract", ADR-0010).
 *
 * - Kinds: `comment` (top-level CommentRecords), `reply`, `chat`
 *   (LiveChatMessages) and `video` are `UNION ALL` branches merged into one
 *   ordered page; each joins `videos` for the title and the video's date.
 * - Terms: every term must be a substring of the record's `search_text`
 *   (normalized again here, so hand-built queries match like parsed ones).
 * - Filters: Channel; `from`/`to` on the hit's own day, `videoFrom`/`videoTo`
 *   on the video's day (inclusive, UTC); `author` as a `UC…` id (exact
 *   `authorChannelId`) or a normalized display-name substring (see
 *   `resolveAuthorNames`); `timestamped` keeps CommentRecords with
 *   TimeAnchors and every LiveChatMessage. An author filter or `timestamped`
 *   excludes video hits.
 * - TTL: expired CommentRecords and LiveChatMessages never match or appear.
 * - Sort: `newest`, `oldest`, `likes` (chat and videos count as 0 likes).
 * - Pages: 25 hits, offset `(page - 1) * 25`; one extra row is fetched to
 *   compute `hasNextPage`. TimeAnchors for the page load in one more query.
 *
 * An {@link isEmptySearch} query returns an empty page without any query.
 *
 * @throws RangeError when `query.page` is not an integer from 1 to 40, or
 *   `query.terms` holds more than {@link SEARCH_MAX_TERMS} terms.
 */
export async function searchCatalog(executor: Executor, query: SearchQuery): Promise<SearchPage> {
  const { page } = query;
  if (!Number.isSafeInteger(page) || page < 1 || page > SEARCH_MAX_PAGE) {
    throw new RangeError(`searchCatalog: page must be 1..${SEARCH_MAX_PAGE}, got ${page}`);
  }
  // The cap keeps every statement under D1's 100 bound parameters (~16 per
  // UNION branch at 8 terms); parseSearchQuery enforces it for the route.
  if (query.terms.length > SEARCH_MAX_TERMS) {
    throw new RangeError(
      `searchCatalog: at most ${SEARCH_MAX_TERMS} terms, got ${query.terms.length}`,
    );
  }
  const empty: SearchPage = { hits: [], hasNextPage: false, page };

  // Normalize first: a term or author that folds to '' (e.g. "%%") is no
  // filter at all, and must not turn a query into a whole-Catalog listing.
  const terms = query.terms.map(normalizeSearchText).filter((term) => term !== '');
  const rawAuthor = query.author;
  const needle =
    rawAuthor === null || CHANNEL_ID.test(rawAuthor) ? rawAuthor : normalizeSearchText(rawAuthor);
  const authorValue = needle === '' ? null : needle;
  if (isEmptySearch({ ...query, terms, author: authorValue })) return empty;

  let author: AuthorFilter = { by: 'none' };
  if (authorValue !== null) {
    if (CHANNEL_ID.test(authorValue)) {
      author = { by: 'channelId', value: authorValue };
    } else {
      const names = await resolveAuthorNames(executor, query, authorValue);
      if (names.length === 0) return empty;
      author = { by: 'names', names };
    }
  }

  const parts = branches(query, terms, author);
  if (parts.length === 0) return empty;

  const union = parts.map((part) => part.sql).join(' UNION ALL ');
  const paged = buildQuery(`SELECT * FROM (${union})`, {
    order: { by: query.sort, orderings: ORDERINGS },
    limit: SEARCH_PAGE_SIZE + 1,
    offset: (page - 1) * SEARCH_PAGE_SIZE,
  });
  const params: SqlValue[] = [...parts.flatMap((part) => part.params), ...paged.params];
  const rows = await executor.all<HitRow>(paged.sql, params);

  const pageRows = rows.slice(0, SEARCH_PAGE_SIZE);
  const commentIds = pageRows
    .filter((row) => row.kind === 'comment' || row.kind === 'reply')
    .map((row) => row.record_id);
  const anchors = await loadAnchorSeconds(executor, commentIds);

  return {
    hits: pageRows.map((row) => toSearchHit(row, anchors)),
    hasNextPage: rows.length > SEARCH_PAGE_SIZE,
    page,
  };
}
