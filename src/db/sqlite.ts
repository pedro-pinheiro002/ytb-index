/**
 * SQLite connection lifecycle for ytb-index.
 *
 * `openSqlite(path)` is the single entry point the rest of `src/db` (and the
 * CLI/server) uses to obtain a better-sqlite3 handle:
 *
 *  1. Open the database with `better-sqlite3` (synchronous API).
 *  2. Force `PRAGMA foreign_keys = ON` and `PRAGMA journal_mode = WAL`.
 *  3. Read `docs/spec/v1/schema.sql` from disk at runtime and execute it
 *     verbatim. The schema uses `CREATE ... IF NOT EXISTS`, so opening the
 *     same database a second time is idempotent.
 *
 * The schema is loaded relative to this module (not `process.cwd()`) so tests
 * and compiled output resolve it consistently. No queries live here — see
 * `./queries.ts`.
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A live SQLite connection. Exposed as a plain better-sqlite3 handle so query
 * helpers can `prepare`/`exec`/`transaction` directly.
 */
export type DbHandle = Database.Database;

/** Absolute path to the authoritative v1 schema, resolved from this module. */
const SCHEMA_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../docs/spec/v1/schema.sql',
);

/**
 * Open (or create) the database at `path` and ensure the v1 schema is applied.
 *
 * @param path Filesystem path, or `':memory:'` for an ephemeral database.
 * @returns A better-sqlite3 handle with foreign keys enforced and the schema
 *          present. The caller owns the handle and should `close()` it.
 */
export function openSqlite(path: string): DbHandle {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  return db;
}
