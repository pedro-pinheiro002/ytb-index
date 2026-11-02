/**
 * Count D1 rows written by Ingest statements (`scripts/measure/rows-written`),
 * for ADR-0012's second validation (proposed): how many of D1's "rows
 * written" one CommentRecord costs, indexes included.
 *
 * Runs the statements through a D1 binding, in batches, and sums each
 * statement's `meta.rows_written` under the table it writes. The binding is
 * structural so a test can pass a fake; the measuring script passes the local
 * workerd D1 from `wrangler`'s `getPlatformProxy`, which reports the same
 * meta as production D1.
 */
import type { Statement } from '../../src/db/executor.ts';

/** The slice of a D1 binding this module needs. */
export interface RowsWrittenBinding {
  prepare(sql: string): { bind(...values: unknown[]): unknown };
  batch(statements: unknown[]): Promise<Array<{ meta?: { rows_written?: number } }>>;
}

/** Statements run and rows written, per table. */
export type RowsWrittenTally = Record<string, { statements: number; rowsWritten: number }>;

/** The table an `INSERT INTO <table>` statement writes, or `other`. */
export function tableOf(sql: string): string {
  return /INSERT\s+INTO\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(sql)?.[1] ?? 'other';
}

/**
 * Run `statements` in batches of `chunkSize` and tally `meta.rows_written`
 * per table. `undefined` params are bound as `NULL`, as D1 rejects
 * `undefined`.
 */
export async function measureRowsWritten(
  binding: RowsWrittenBinding,
  statements: readonly Statement[],
  chunkSize = 50,
): Promise<RowsWrittenTally> {
  const tally: RowsWrittenTally = {};
  for (let offset = 0; offset < statements.length; offset += chunkSize) {
    const chunk = statements.slice(offset, offset + chunkSize);
    const results = await binding.batch(
      chunk.map((statement) =>
        binding
          .prepare(statement.sql)
          .bind(...(statement.params ?? []).map((value) => (value === undefined ? null : value))),
      ),
    );
    chunk.forEach((statement, index) => {
      const table = tableOf(statement.sql);
      const entry = (tally[table] ??= { statements: 0, rowsWritten: 0 });
      entry.statements += 1;
      entry.rowsWritten += results[index]?.meta?.rows_written ?? 0;
    });
  }
  return tally;
}
