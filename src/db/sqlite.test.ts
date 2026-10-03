/**
 * Integration tests for `openCatalog` (better-sqlite3 Executor + migrations).
 *
 * Verifies migration application (all v1 tables, the `comments_active` view,
 * migration bookkeeping), idempotency when re-opening the same database file,
 * and that foreign-key enforcement is actually on.
 *
 * Run via `pnpm test` (node:test runner).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalog, type SqliteExecutor } from './sqlite.ts';

const EXPECTED_SCHEMA_OBJECTS = [
  'channels',
  'videos',
  'comments',
  'time_anchors',
  'comments_active',
  'd1_migrations',
];

async function schemaObjectNames(db: SqliteExecutor): Promise<Set<string>> {
  const rows = await db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type IN ('table', 'view')",
  );
  return new Set(rows.map((row) => row.name));
}

describe('openCatalog', () => {
  it('applies the v1 schema and records the migration', async () => {
    const db = await openCatalog(':memory:');
    try {
      const names = await schemaObjectNames(db);
      for (const object of EXPECTED_SCHEMA_OBJECTS) {
        assert.ok(names.has(object), `expected schema object ${object}`);
      }
      const applied = await db.all<{ name: string }>('SELECT name FROM d1_migrations');
      assert.deepEqual(
        applied.map((row) => row.name),
        ['0001_init.sql'],
      );
    } finally {
      db.close();
    }
  });

  it('re-opening the same database file is idempotent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ytb-index-sqlite-'));
    const file = join(dir, 'db.sqlite');
    try {
      const first = await openCatalog(file);
      first.close();

      // The second open skips the already-recorded migration; IF NOT EXISTS
      // keeps the DDL itself a no-op too.
      const second = await openCatalog(file);
      try {
        const names = await schemaObjectNames(second);
        for (const object of EXPECTED_SCHEMA_OBJECTS) {
          assert.ok(names.has(object), `expected schema object ${object} after re-open`);
        }
        const applied = await second.all<{ name: string }>('SELECT name FROM d1_migrations');
        assert.equal(applied.length, 1);
      } finally {
        second.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enables foreign key enforcement', async () => {
    const db = await openCatalog(':memory:');
    try {
      await assert.rejects(
        db.run(
          `INSERT INTO comments (id, video_id, channel_id, text, published_at, fetched_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          ['c1', 'v_missing', 'ch_missing', 'x', '2020-01-01', '2020-01-01'],
        ),
        /FOREIGN KEY/i,
      );
    } finally {
      db.close();
    }
  });
});
