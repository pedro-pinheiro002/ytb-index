/**
 * Tests for source excerpt collection (`src/agent/context`).
 *
 * The contract that matters: the agent reads only `src/`, never leaves the
 * repository, and never lets an arbitrary stack frame turn into an arbitrary
 * file read. Fixtures are real files in a temp dir so path resolution is the
 * actual `node:path` behavior, not a mock of it.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectContext, isSourcePath, resolveInside } from './context.ts';
import type { SentryFrame } from './sentry.ts';

/** 200 numbered lines, so windows and clamps are visible in assertions. */
const LONG_FILE = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`).join('\n');

let root: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-context-'));
  mkdirSync(join(root, 'src', 'server'), { recursive: true });
  writeFileSync(join(root, 'src', 'worker.ts'), LONG_FILE);
  writeFileSync(join(root, 'src', 'server', 'app.ts'), LONG_FILE);
  writeFileSync(join(root, 'src', 'server', 'quiet.ts'), LONG_FILE);
  writeFileSync(join(root, 'package.json'), '{"name":"ytb-index"}');
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Build a frame with the fields `collectContext` reads. */
function frame(filename: string, lineNo?: number, inApp = true): SentryFrame {
  return { filename, fn: 'boom', lineNo, colNo: undefined, inApp, contextLine: undefined };
}

describe('isSourcePath', () => {
  it('accepts TypeScript under src/', () => {
    assert.equal(isSourcePath('src/worker.ts'), true);
    assert.equal(isSourcePath('src/server/api/agent-hook.tsx'), true);
    assert.equal(isSourcePath('src/a/b-c_d.ts'), true);
  });

  it('rejects everything the patch allowlist also rejects', () => {
    assert.equal(isSourcePath('.github/workflows/ci.yml'), false);
    assert.equal(isSourcePath('package.json'), false);
    assert.equal(isSourcePath('wrangler.jsonc'), false);
    assert.equal(isSourcePath('migrations/0001_init.sql'), false);
    assert.equal(isSourcePath('src/data.json'), false);
    assert.equal(isSourcePath('script.sh'), false);
  });

  it('rejects traversal, absolute paths, and empty segments', () => {
    assert.equal(isSourcePath('src/../package.json'), false);
    assert.equal(isSourcePath('/etc/passwd'), false);
    assert.equal(isSourcePath('src/../../etc/passwd.ts'), false);
    assert.equal(isSourcePath(''), false);
  });
});

describe('resolveInside', () => {
  it('returns an absolute path inside the repository root', () => {
    const resolved = resolveInside(root, 'src/worker.ts');
    assert.equal(resolved, join(root, 'src', 'worker.ts'));
  });

  it('refuses paths that escape the root even when the prefix matches', () => {
    assert.equal(resolveInside(root, 'src/../../etc/passwd.ts'), undefined);
  });

  it('refuses non-source paths before touching the filesystem', () => {
    assert.equal(resolveInside(root, 'package.json'), undefined);
  });
});

describe('collectContext', () => {
  it('centers the excerpt on the failing line', () => {
    const [context, ...rest] = collectContext(root, [frame('src/worker.ts', 100)]);
    assert.equal(rest.length, 0);
    assert.equal(context?.path, 'src/worker.ts');
    // 40 lines before the frame, clamped at 1.
    assert.equal(context?.startLine, 60);
    assert.equal(context?.text.split('\n')[0], 'line 60');
  });

  it('clamps the window at the start of the file', () => {
    const [context] = collectContext(root, [frame('src/worker.ts', 5)]);
    assert.equal(context?.startLine, 1);
    assert.equal(context?.text.split('\n')[0], 'line 1');
  });

  it('clamps the window at the end of the file', () => {
    const [context] = collectContext(root, [frame('src/worker.ts', 195)]);
    const lines = context?.text.split('\n') ?? [];
    assert.equal(context?.startLine, 155);
    // 155..200 inclusive.
    assert.equal(lines.length, 46);
    assert.equal(lines.at(-1), 'line 200');
  });

  it('treats a frame without a line number as line 1', () => {
    const [context] = collectContext(root, [frame('src/worker.ts')]);
    assert.equal(context?.startLine, 1);
  });

  it('prefers the innermost frame when two frames share a file', () => {
    // Sentry lists the innermost frame last.
    const contexts = collectContext(root, [
      frame('src/worker.ts', 10),
      frame('src/worker.ts', 150),
    ]);
    assert.equal(contexts.length, 1);
    assert.equal(contexts[0]?.startLine, 110);
  });

  it('skips frames that are not in the app', () => {
    const contexts = collectContext(root, [
      frame('src/worker.ts', 10, false),
      frame('src/server/app.ts', 10),
    ]);
    assert.deepEqual(
      contexts.map((context) => context.path),
      ['src/server/app.ts'],
    );
  });

  it('skips files that do not exist instead of failing the run', () => {
    const contexts = collectContext(root, [frame('src/missing.ts', 10)]);
    assert.deepEqual(contexts, []);
  });

  it('skips paths outside src/ even when the frame claims otherwise', () => {
    const contexts = collectContext(root, [
      frame('package.json', 1),
      frame('src/../package.json', 1),
      frame('/etc/passwd', 1),
    ]);
    assert.deepEqual(contexts, []);
  });

  it('strips a leading ./ from the frame filename', () => {
    const [context] = collectContext(root, [frame('./src/worker.ts', 10)]);
    assert.equal(context?.path, 'src/worker.ts');
  });

  it('caps the number of files', () => {
    const contexts = collectContext(
      root,
      [
        frame('src/worker.ts', 10),
        frame('src/server/app.ts', 10),
        frame('src/server/quiet.ts', 10),
      ],
      { maxFiles: 2 },
    );
    assert.equal(contexts.length, 2);
  });

  it('caps the lines per file', () => {
    const [context] = collectContext(root, [frame('src/worker.ts', 100)], { maxLines: 10 });
    assert.equal(context?.text.split('\n').length, 10);
  });

  it('returns frames in innermost-first order', () => {
    const contexts = collectContext(root, [
      frame('src/worker.ts', 10),
      frame('src/server/app.ts', 20),
    ]);
    assert.deepEqual(
      contexts.map((context) => context.path),
      ['src/server/app.ts', 'src/worker.ts'],
    );
  });
});
