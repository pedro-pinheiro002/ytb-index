/**
 * Test support (`db/sqlite-backed-d1`): a `D1Binding` double that records
 * every bound statement and answers it from another `Executor` (in practice
 * a seeded `openCatalog(':memory:')`). Extracted from `./filter.test.ts` for
 * F4 (#50) so Catalog search tests can prove the same SQL runs through
 * `createD1Executor` (spec v2 "Testing Decisions", ADR-0010).
 *
 * Imports no Node module, so it is safe anywhere in `src/db`; only tests use
 * it.
 */
import type { D1Binding, D1PreparedStatement } from './d1.ts';
import type { Executor } from './executor.ts';

/** A `D1Binding` double that records bound statements and runs them on SQLite. */
export class SqliteBackedBinding implements D1Binding {
  /** Every `bind(...)` call, in order: the SQL and its positional values. */
  readonly bound: Array<{ sql: string; params: unknown[] }> = [];
  readonly #db: Executor;

  /** @param db The executor that answers every statement. */
  constructor(db: Executor) {
    this.#db = db;
  }

  /** Prepare `sql` with no bound values yet. */
  prepare(sql: string): D1PreparedStatement {
    return this.#statement(sql, []);
  }

  #statement(sql: string, params: unknown[]): D1PreparedStatement {
    return {
      bind: (...values: unknown[]) => {
        this.bound.push({ sql, params: values });
        return this.#statement(sql, values);
      },
      all: async <T>() => ({ results: await this.#db.all<T>(sql, params) }),
      first: async <T>() => (await this.#db.get<T>(sql, params)) ?? null,
      run: async () => ({ meta: { changes: await this.#db.run(sql, params) } }),
    };
  }

  /** Not supported: the read-side tests never batch. */
  async batch(): Promise<unknown[]> {
    throw new Error('SqliteBackedBinding: batch is not supported');
  }
}
