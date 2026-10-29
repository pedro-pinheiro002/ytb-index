/**
 * Portable filter builder (`db/filter`): R2 (#46), groundwork for Catalog
 * search (ADR-0010, v2 spec "SearchQuery contract").
 *
 * `buildQuery` appends typed predicates (ANDed), an `ORDER BY` picked from a
 * caller-supplied whitelist, and `LIMIT` / `OFFSET` to a base `SELECT`, and
 * returns one SQL string plus its positional `?` params. Values are always
 * bound, never interpolated; column names and ordering clauses come from code
 * and are validated, so a request value can never reach the SQL text. The
 * output is plain SQLite that runs unchanged on better-sqlite3 and D1.
 *
 * `contains` predicates compile to ADR-0010's
 * `column LIKE '%' || ? || '%' ESCAPE '\'`, with the term passed through
 * {@link escapeLike} so `%`, `_` and `\` match literally.
 *
 * First production caller: Catalog search, F4 (#50), `./catalog-search.ts`.
 */
import type { Statement } from './executor.ts';

/** A value that can be bound to a positional `?` parameter. */
export type SqlValue = string | number | null;

/**
 * One typed predicate over a column. `column` is a code-side identifier
 * (`name` or `alias.name`), never a request value.
 *
 * - `eq` / `gte` / `lte` / `lt`: `column = ?`, `column >= ?`, `column <= ?`,
 *   `column < ?`.
 * - `isNull` / `notNull`: `column IS NULL`, `column IS NOT NULL` (no param).
 * - `in`: `column IN (?, …)`; an empty `values` list matches no row.
 * - `inJson`: `column IN (SELECT value FROM json_each(?))`, the list bound as
 *   one JSON array param, so a long list never hits D1's bound-parameter cap
 *   (F4 #50: author names resolved in JS). An empty list matches no row.
 * - `contains`: LIKE-escaped substring match (ADR-0010).
 */
export type Predicate =
  | { op: 'eq' | 'gte' | 'lte' | 'lt'; column: string; value: SqlValue }
  | { op: 'isNull' | 'notNull'; column: string }
  | { op: 'in' | 'inJson'; column: string; values: readonly SqlValue[] }
  | { op: 'contains'; column: string; value: string };

/** What {@link buildQuery} appends to a base `SELECT`. */
export interface QueryOptions<K extends string> {
  /** Predicates, ANDed. Empty or omitted → no `WHERE` clause. */
  where?: readonly Predicate[];
  /**
   * Ordering: `by` must be a key of `orderings`, the whitelist of code-side
   * `ORDER BY` clauses (e.g. `{ newest: 'published_at DESC, id DESC' }`).
   */
  order?: { by: K; orderings: Readonly<Record<K, string>> };
  /** Maximum rows, bound as a param. A non-negative integer. */
  limit?: number;
  /** Rows to skip, bound as a param. A non-negative integer. */
  offset?: number;
}

/** A built statement whose params are always present. */
export interface BuiltQuery extends Statement {
  params: SqlValue[];
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

function column(name: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new TypeError(`filter: invalid column name ${JSON.stringify(name)}`);
  }
  return name;
}

function count(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`filter: ${name} must be a non-negative integer, got ${value}`);
  }
  return value;
}

const COMPARATORS = { eq: '=', gte: '>=', lte: '<=', lt: '<' } as const;

function compile(predicate: Predicate): { sql: string; params: SqlValue[] } {
  const target = column(predicate.column);
  switch (predicate.op) {
    case 'eq':
    case 'gte':
    case 'lte':
    case 'lt':
      return { sql: `${target} ${COMPARATORS[predicate.op]} ?`, params: [predicate.value] };
    case 'in':
      if (predicate.values.length === 0) return { sql: '0 = 1', params: [] };
      return {
        sql: `${target} IN (${predicate.values.map(() => '?').join(', ')})`,
        params: [...predicate.values],
      };
    case 'isNull':
      return { sql: `${target} IS NULL`, params: [] };
    case 'notNull':
      return { sql: `${target} IS NOT NULL`, params: [] };
    case 'inJson':
      if (predicate.values.length === 0) return { sql: '0 = 1', params: [] };
      return {
        sql: `${target} IN (SELECT value FROM json_each(?))`,
        params: [JSON.stringify(predicate.values)],
      };
    case 'contains':
      return {
        sql: `${target} LIKE '%' || ? || '%' ESCAPE '\\'`,
        params: [escapeLike(predicate.value)],
      };
  }
}

/**
 * Escape LIKE metacharacters (`\`, `%`, `_`) with `\`, for use with
 * `LIKE ? ESCAPE '\'`, so the value matches literally.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Append `WHERE` (ANDed predicates), `ORDER BY` (from the whitelist),
 * `LIMIT ?` and `OFFSET ?` to `select`, in that order, and collect the params
 * positionally. An `offset` without a `limit` emits `LIMIT -1` (SQLite's "no
 * limit"), since SQLite requires `LIMIT` before `OFFSET`.
 *
 * @throws TypeError on a malformed column name or an `order.by` that is not
 *         a whitelisted key; RangeError on a negative or fractional
 *         `limit` / `offset`.
 */
export function buildQuery<K extends string>(
  select: string,
  options: QueryOptions<K> = {},
): BuiltQuery {
  const clauses = [select.trim()];
  const params: SqlValue[] = [];

  const predicates = (options.where ?? []).map(compile);
  if (predicates.length > 0) {
    clauses.push(`WHERE ${predicates.map((p) => p.sql).join(' AND ')}`);
    params.push(...predicates.flatMap((p) => p.params));
  }

  if (options.order !== undefined) {
    const { by, orderings } = options.order;
    if (!Object.hasOwn(orderings, by)) {
      throw new TypeError(`filter: ordering ${JSON.stringify(by)} is not whitelisted`);
    }
    clauses.push(`ORDER BY ${orderings[by]}`);
  }

  if (options.limit !== undefined) {
    clauses.push('LIMIT ?');
    params.push(count('limit', options.limit));
  } else if (options.offset !== undefined) {
    clauses.push('LIMIT -1');
  }
  if (options.offset !== undefined) {
    clauses.push('OFFSET ?');
    params.push(count('offset', options.offset));
  }

  return { sql: clauses.join(' '), params };
}
