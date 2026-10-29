/**
 * Module boundary tests (`src/architecture`).
 *
 * The boundaries below used to live only in module header comments. They are
 * checked here so a change that crosses one fails `pnpm test` with a message
 * naming the rule, instead of failing later on deploy or not at all.
 *
 * The scan is deliberately simple: static `from '…'` / `import '…'` and
 * dynamic `import('…')` specifiers, read with a regex after stripping
 * comments. Type-only imports count too. Test files are exempt.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = dirname(fileURLToPath(import.meta.url));

/** A non-test source file and what it imports. */
interface SourceFile {
  /** Path relative to `src/`, with `/` separators (e.g. `server/app.ts`). */
  path: string;
  /** Code with comments removed. */
  code: string;
  /** Relative imports, resolved to paths relative to `src/`. */
  local: string[];
  /** Bare specifiers: packages and `node:*` builtins. */
  external: string[];
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function specifiers(code: string): string[] {
  const pattern = /(?:\bfrom\s+|\bimport\s+|\bimport\s*\(\s*)'([^']+)'/g;
  return [...code.matchAll(pattern)].map((match) => match[1] ?? '');
}

function listSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listSources(full);
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
    return [full];
  });
}

function toSrcPath(full: string): string {
  return relative(SRC, full).split('\\').join('/');
}

const FILES: SourceFile[] = listSources(SRC).map((full) => {
  const code = stripComments(readFileSync(full, 'utf8'));
  const all = specifiers(code);
  return {
    path: toSrcPath(full),
    code,
    local: all.filter((s) => s.startsWith('.')).map((s) => toSrcPath(resolve(dirname(full), s))),
    external: all.filter((s) => !s.startsWith('.')),
  };
});

const BY_PATH = new Map(FILES.map((file) => [file.path, file]));

/** Top-level module of a `src/`-relative path: `server`, `db`, … or `worker.ts`. */
function moduleOf(path: string): string {
  return path.split('/')[0] ?? path;
}

/**
 * Which modules each module may import (besides itself). The rule text is
 * what a failing assertion prints, so it names the reason.
 */
const ALLOWED: Record<string, { modules: string[]; rule: string }> = {
  shared: { modules: [], rule: 'src/shared holds domain types and imports nothing.' },
  yt: { modules: ['shared'], rule: 'src/yt (YouTube client) depends only on src/shared.' },
  db: { modules: ['shared'], rule: 'src/db depends only on src/shared.' },
  server: {
    modules: ['db', 'shared'],
    rule: 'src/server must not import the ingest pipeline (src/yt, src/cli) — ADR-0002/0003.',
  },
  'worker.ts': { modules: ['server', 'db'], rule: 'src/worker.ts wires src/server to D1.' },
  cli: { modules: ['yt', 'db', 'shared'], rule: 'src/cli orchestrates yt + db.' },
  agent: {
    modules: [],
    rule: 'src/agent (repair agent) is isolated from the product code — ADR-0006.',
  },
};

/** Specifiers that cannot run in a Worker, or must stay out of its bundle. */
function isNodeOnly(specifier: string): boolean {
  return (
    specifier.startsWith('node:') ||
    ['better-sqlite3', '@hono/node-server', 'dotenv', 'dotenv/config'].includes(specifier)
  );
}

/** Every file reachable from `entry` through relative imports. */
function importGraph(entry: string): SourceFile[] {
  const seen = new Map<string, SourceFile>();
  const queue = [entry];
  while (queue.length > 0) {
    const path = queue.pop() ?? '';
    const file = BY_PATH.get(path);
    if (file === undefined || seen.has(path)) continue;
    seen.set(path, file);
    queue.push(...file.local);
  }
  return [...seen.values()];
}

describe('architecture', () => {
  it('finds the source tree', () => {
    assert.ok(BY_PATH.has('worker.ts'));
    assert.ok(BY_PATH.has('server/app.ts'));
  });

  it('every top-level module has a boundary rule', () => {
    const unknown = [...new Set(FILES.map((file) => moduleOf(file.path)))].filter(
      (name) => !(name in ALLOWED),
    );
    assert.deepEqual(unknown, [], 'add the new module to ALLOWED in src/architecture.test.ts');
  });

  it('modules import only what their rule allows', () => {
    const violations = FILES.flatMap((file) => {
      const from = moduleOf(file.path);
      const allowed = ALLOWED[from];
      if (allowed === undefined) return [];
      return file.local
        .filter((target) => {
          const to = moduleOf(target);
          return to !== from && !allowed.modules.includes(to);
        })
        .map((target) => `${file.path} -> ${target}: ${allowed.rule}`);
    });
    assert.deepEqual(violations, []);
  });

  it('the Worker import graph has no Node-only imports and no process.env', () => {
    // `nodejs_compat` (wrangler.jsonc) polyfills `node:*`, so the bundle step
    // would not catch these; the Worker must still not depend on them.
    const violations = importGraph('worker.ts').flatMap((file) => [
      ...file.external
        .filter(isNodeOnly)
        .map((specifier) => `${file.path} imports ${specifier}: the Worker graph is Node-free`),
      ...(/\bprocess\.env\b/.test(file.code)
        ? [`${file.path} reads process.env: Worker config comes from \`env\` bindings`]
        : []),
    ]);
    assert.deepEqual(violations, []);
  });

  it('only src/db/sqlite.ts touches Node in src/db', () => {
    const violations = FILES.filter((file) => moduleOf(file.path) === 'db')
      .filter((file) => file.path !== 'db/sqlite.ts')
      .flatMap((file) =>
        file.external.filter(isNodeOnly).map((specifier) => `${file.path} imports ${specifier}`),
      );
    assert.deepEqual(violations, [], 'only src/db/sqlite.ts may use Node builtins');
  });

  it('process.env is read only by entry points', () => {
    const entries = (path: string): boolean =>
      ['cli', 'agent'].includes(moduleOf(path)) || path === 'server/index.ts';
    const violations = FILES.filter(
      (file) => !entries(file.path) && /\bprocess\.env\b/.test(file.code),
    ).map((file) => file.path);
    assert.deepEqual(
      violations,
      [],
      'read config in an entry point (src/cli, src/agent, src/server/index.ts) and inject it',
    );
  });
});
