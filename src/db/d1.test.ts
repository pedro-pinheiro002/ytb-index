/**
 * Unit tests for `createD1Executor` against a hand-rolled in-memory
 * `D1Binding` — no network, no wrangler, no Cloudflare global types.
 *
 * Covers the Executor mapping: bind order, `all` → `results`, `first` →
 * row/`undefined`, `run` → `meta.changes`, and `batch` forwarding.
 *
 * Run via `pnpm test` (node:test runner).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createD1Executor, type D1Binding, type D1PreparedStatement } from './d1.ts';

/** One recorded execution: which SQL ran with which bound params. */
interface Execution {
  sql: string;
  params: unknown[];
}

/** In-memory `D1PreparedStatement` that records executions on its binding. */
class FakeStatement implements D1PreparedStatement {
  readonly sql: string;
  readonly params: unknown[];
  readonly #binding: FakeBinding;

  constructor(binding: FakeBinding, sql: string, params: unknown[]) {
    this.#binding = binding;
    this.sql = sql;
    this.params = params;
  }

  bind(...values: unknown[]): D1PreparedStatement {
    return new FakeStatement(this.#binding, this.sql, values);
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    this.#binding.executed.push({ sql: this.sql, params: [...this.params] });
    return { results: (this.#binding.results[this.sql] ?? []) as T[] };
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    this.#binding.executed.push({ sql: this.sql, params: [...this.params] });
    const row = this.#binding.firstRows[this.sql];
    return (row ?? null) as T | null;
  }

  async run(): Promise<{ meta: { changes: number } }> {
    this.#binding.executed.push({ sql: this.sql, params: [...this.params] });
    return { meta: { changes: this.#binding.changes[this.sql] ?? 0 } };
  }
}

/** Minimal in-memory binding double. */
class FakeBinding implements D1Binding {
  readonly executed: Execution[] = [];
  readonly results: Record<string, unknown[]> = {};
  readonly firstRows: Record<string, unknown> = {};
  readonly changes: Record<string, number> = {};
  readonly batches: D1PreparedStatement[][] = [];

  prepare(sql: string): D1PreparedStatement {
    return new FakeStatement(this, sql, []);
  }

  async batch(statements: D1PreparedStatement[]): Promise<unknown[]> {
    this.batches.push(statements);
    return [];
  }
}

describe('createD1Executor', () => {
  it('all() binds params in order and unwraps results', async () => {
    const binding = new FakeBinding();
    binding.results['SELECT id FROM videos WHERE channel_id = ?'] = [{ id: 'v1' }, { id: 'v2' }];

    const executor = createD1Executor(binding);
    const rows = await executor.all<{ id: string }>('SELECT id FROM videos WHERE channel_id = ?', [
      'UC1',
    ]);

    assert.deepEqual(rows, [{ id: 'v1' }, { id: 'v2' }]);
    assert.deepEqual(binding.executed, [
      { sql: 'SELECT id FROM videos WHERE channel_id = ?', params: ['UC1'] },
    ]);
  });

  it('all() with no params binds nothing', async () => {
    const binding = new FakeBinding();
    const executor = createD1Executor(binding);

    assert.deepEqual(await executor.all('SELECT 1'), []);
    assert.deepEqual(binding.executed, [{ sql: 'SELECT 1', params: [] }]);
  });

  it('get() returns the first row and maps null to undefined', async () => {
    const binding = new FakeBinding();
    binding.firstRows['SELECT fetched_at FROM channels LIMIT 1'] = {
      fetched_at: '2024-03-01T00:00:00.000Z',
    };

    const executor = createD1Executor(binding);
    assert.deepEqual(await executor.get('SELECT fetched_at FROM channels LIMIT 1'), {
      fetched_at: '2024-03-01T00:00:00.000Z',
    });
    assert.equal(await executor.get('SELECT 1 WHERE 0', ['x']), undefined);
    assert.deepEqual(binding.executed, [
      { sql: 'SELECT fetched_at FROM channels LIMIT 1', params: [] },
      { sql: 'SELECT 1 WHERE 0', params: ['x'] },
    ]);
  });

  it('run() returns meta.changes and defaults to 0', async () => {
    const binding = new FakeBinding();
    binding.changes['DELETE FROM comments WHERE video_id = ?'] = 2;

    const executor = createD1Executor(binding);
    assert.equal(await executor.run('DELETE FROM comments WHERE video_id = ?', ['v1']), 2);
    assert.equal(await executor.run('DELETE FROM missing'), 0);
    assert.deepEqual(binding.executed, [
      { sql: 'DELETE FROM comments WHERE video_id = ?', params: ['v1'] },
      { sql: 'DELETE FROM missing', params: [] },
    ]);
  });

  it('batch() forwards every prepared statement in order', async () => {
    const binding = new FakeBinding();
    const executor = createD1Executor(binding);

    await executor.batch([
      { sql: 'INSERT INTO channels (id) VALUES (?)', params: ['c1'] },
      { sql: 'DELETE FROM videos' },
    ]);

    assert.equal(binding.batches.length, 1);
    const prepared = binding.batches[0] as FakeStatement[];
    assert.equal(prepared.length, 2);
    assert.deepEqual(
      prepared.map((statement) => statement.sql),
      ['INSERT INTO channels (id) VALUES (?)', 'DELETE FROM videos'],
    );
    assert.deepEqual(
      prepared.map((statement) => statement.params),
      [['c1'], []],
    );
    assert.deepEqual(binding.executed, []); // batch() must not run statements one by one
  });

  it('batch() with no statements never calls the binding', async () => {
    const binding = new FakeBinding();
    const executor = createD1Executor(binding);

    await executor.batch([]);

    assert.deepEqual(binding.batches, []);
  });
});
