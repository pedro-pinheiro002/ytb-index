/**
 * Cloudflare D1 implementation of the `Executor` interface (`db/d1`).
 *
 * Deliberately typed structurally instead of importing
 * `@cloudflare/workers-types`: those globals conflict with `@types/node`
 * under this repo's single tsconfig, and the Worker bundle only needs the
 * surface declared here. The real `D1Database` binding satisfies `D1Binding`
 * at runtime.
 *
 * Thin by design: rows come back exactly as the binding returns them. D1 may
 * return JSON-stringified values for some column types; this executor
 * surfaces them raw and leaves parsing/coercion to callers/views.
 *
 * `batch` maps to D1's own batch, which is atomic (all statements commit or
 * none do) — the same contract as the local `Executor.batch`.
 */
import type { Executor, Statement } from './executor.ts';

/** Minimal structural D1 prepared-statement surface used by the executor. */
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<{ meta: { changes?: number } }>;
}

/** Minimal structural D1 database binding (one `d1_databases` entry). */
export interface D1Binding {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown[]>;
}

/** Wrap a D1 binding as the shared async `Executor`. */
export function createD1Executor(binding: D1Binding): Executor {
  return {
    async all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      const { results } = await binding
        .prepare(sql)
        .bind(...params)
        .all<T>();
      return results;
    },

    async get<T = Record<string, unknown>>(
      sql: string,
      params: unknown[] = [],
    ): Promise<T | undefined> {
      const row = await binding
        .prepare(sql)
        .bind(...params)
        .first<T>();
      return row ?? undefined;
    },

    async run(sql: string, params: unknown[] = []): Promise<number> {
      const { meta } = await binding
        .prepare(sql)
        .bind(...params)
        .run();
      return meta.changes ?? 0;
    },

    async batch(statements: Statement[]): Promise<void> {
      if (statements.length === 0) return;
      const prepared = statements.map((statement) =>
        binding.prepare(statement.sql).bind(...(statement.params ?? [])),
      );
      await binding.batch(prepared);
    },
  };
}
