/**
 * The one database abstraction shared by every environment: the local
 * better-sqlite3 implementation (`./sqlite.ts`) and the production D1
 * implementation (later lane).
 *
 * Every method is async, and every SQL string run through an `Executor` must
 * be portable between SQLite and D1: positional `?` parameters only, no
 * engine-specific pragmas. Connection pragmas (foreign keys, WAL) belong to
 * the concrete implementation, not to shared SQL.
 */

/** One portable statement, as accepted by {@link Executor.batch}. */
export interface Statement {
  sql: string;
  params?: unknown[];
}

/** Async, SQL-portable access to the catalog database. */
export interface Executor {
  /** Run a query and return every row. */
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Run a query and return the first row, or `undefined` when there is none. */
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  /** Run a write statement; resolves to the number of affected rows. */
  run(sql: string, params?: unknown[]): Promise<number>;
  /** Apply every statement atomically: all commit, or none do. */
  batch(statements: Statement[]): Promise<void>;
}
