/**
 * Integration tests for `openSqlite`.
 *
 * Verifies schema application (all v1 tables + the `comments_active` view),
 * idempotency when re-opening the same database file, and that foreign-key
 * enforcement is actually on.
 *
 * Run via `pnpm test` (node:test runner).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqlite } from './sqlite.ts';

const EXPECTED_SCHEMA_OBJECTS = [
  'channels',
  'videos',
  'comments',
  'time_anchors',
  'comments_active',
];

function schemaObjectNames(db: ReturnType<typeof openSqlite>): Set<string> {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
    .all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

describe('openSqlite', () => {
  it('applies the v1 schema: four tables and the comments_active view', () => {
    const db = openSqlite(':memory:');
    try {
      const names = schemaObjectNames(db);
      for (const object of EXPECTED_SCHEMA_OBJECTS) {
        assert.ok(names.has(object), `expected schema object ${object}`);
      }
    } finally {
      db.close();
    }
  });

  it('re-opening the same database file is idempotent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ytb-index-sqlite-'));
    const file = join(dir, 'db.sqlite');
    try {
      const first = openSqlite(file);
      first.close();

      // Second open re-executes schema.sql; IF NOT EXISTS must make it a no-op.
      const second = openSqlite(file);
      try {
        const names = schemaObjectNames(second);
        for (const object of EXPECTED_SCHEMA_OBJECTS) {
          assert.ok(names.has(object), `expected schema object ${object} after re-open`);
        }
      } finally {
        second.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enables foreign key enforcement', () => {
    const db = openSqlite(':memory:');
    try {
      assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
      assert.throws(
        () =>
          db
            .prepare(
              `INSERT INTO comments (id, video_id, channel_id, text, published_at, fetched_at)
               VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run('c1', 'v_missing', 'ch_missing', 'x', '2020-01-01', '2020-01-01'),
        /FOREIGN KEY/i,
      );
    } finally {
      db.close();
    }
  });
});
