/**
 * better-sqlite3 implementation of the `Executor` interface + migrations.
 *
 * `openCatalog(dbPath)` is the single entry point the rest of `src/db` (and
 * the CLI/server) uses to obtain a local database:
 *
 *  1. Open the database with `better-sqlite3` (synchronous API) and set the
 *     local-only connection pragmas: `foreign_keys = ON`, `journal_mode = WAL`.
 *  2. Create the `d1_migrations` bookkeeping table and apply every
 *     `migrations/*.sql` file, in filename order, that is not recorded yet.
 *     Each migration is recorded in the same transaction that applies it, so
 *     re-opening the same catalog is a no-op (matching `wrangler d1
 *     migrations apply` on D1).
 *
 * The migrations directory is resolved relative to this module (not
 * `process.cwd()`), so both `tsx src/...` and `node dist/...` resolve the same
 * `<repo>/migrations` path (the build mirrors `src/` under `dist/`). It is not
 * self-contained: a `dist/` copied away from the repo will not find it.
 *
 * No queries live here — see `./queries.ts`.
 */
import Database from 'better-sqlite3';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Executor, Statement } from './executor.ts';

/** Absolute path to the shared migration files, resolved from this module. */
const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations');

/** A local `Executor` that also owns the underlying better-sqlite3 connection. */
export interface SqliteExecutor extends Executor {
  /** Close the underlying connection. The executor must not be used after. */
  close(): void;
}

/** `d1_migrations` mirrors the bookkeeping wrangler keeps on D1. */
const MIGRATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS d1_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )
`;

/** Apply every not-yet-recorded `migrations/*.sql` file, in filename order. */
function applyMigrations(db: Database.Database): void {
  if (!existsSync(MIGRATIONS_DIR)) {
    throw new Error(`migrations directory not found at ${MIGRATIONS_DIR}`);
  }
  db.exec(MIGRATIONS_TABLE_SQL);
  const recorded = new Set(
    (db.prepare('SELECT name FROM d1_migrations').all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const record = db.prepare('INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)');
  const migrate = db.transaction(() => {
    for (const file of files) {
      if (recorded.has(file)) continue;
      db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
      record.run(file, new Date().toISOString());
    }
  });
  migrate();
}

/** Cached prepared statements around one better-sqlite3 connection. */
class BetterSqliteExecutor implements SqliteExecutor {
  readonly #db: Database.Database;
  readonly #statements = new Map<string, Database.Statement<unknown[], unknown>>();
  readonly #applyBatch: (statements: Statement[]) => void;

  constructor(db: Database.Database) {
    this.#db = db;
    this.#applyBatch = db.transaction((statements: Statement[]) => {
      for (const statement of statements) {
        this.#prepare(statement.sql).run(...(statement.params ?? []));
      }
    });
  }

  #prepare(sql: string): Database.Statement<unknown[], unknown> {
    let statement = this.#statements.get(sql);
    if (statement === undefined) {
      statement = this.#db.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  async all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.#prepare(sql).all(...params) as T[];
  }

  async get<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T | undefined> {
    return this.#prepare(sql).get(...params) as T | undefined;
  }

  async run(sql: string, params: unknown[] = []): Promise<number> {
    return this.#prepare(sql).run(...params).changes;
  }

  async batch(statements: Statement[]): Promise<void> {
    if (statements.length === 0) return;
    // better-sqlite3's transaction() wraps BEGIN/COMMIT and rolls back on throw.
    this.#applyBatch(statements);
  }

  close(): void {
    this.#statements.clear();
    this.#db.close();
  }
}

/**
 * Open (or create) the database at `dbPath` and bring its schema up to date.
 *
 * @param dbPath Filesystem path, or `':memory:'` for an ephemeral database.
 * @returns A live {@link SqliteExecutor}; the caller owns it and should
 *          `close()` it when done.
 */
export async function openCatalog(dbPath: string): Promise<SqliteExecutor> {
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  applyMigrations(db);
  return new BetterSqliteExecutor(db);
}
