/**
 * Tests for `src/agent/sourcemap` (ADR-0006).
 *
 * The mapping itself is `@jridgewell/trace-mapping`'s job; what is worth
 * pinning down is our policy: rewrite bundled frames, drop everything that is
 * not `src/**`, and degrade to the original stack instead of throwing.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TraceMap } from '@jridgewell/trace-mapping';
import { isBundledFrame, resolveFrames } from './sourcemap.ts';
import type { SentryFrame } from './sentry.ts';

const ROOT = '/repo';

/** A map with one segment: generated line 1, column 0 → `source` line 10. */
function mapOf(source: string): TraceMap {
  return new TraceMap({
    version: 3,
    sources: [source],
    names: [],
    // [genCol, srcIdx, srcLine, srcCol] = [0, 0, 9, 0], VLQ-encoded.
    mappings: 'AASA',
    sourcesContent: [source],
  });
}

/** Build a frame the way `sentry.ts` normalizes one. */
function frame(filename: string, lineNo?: number, colNo?: number): SentryFrame {
  return { filename, fn: 'fetch', lineNo, colNo, inApp: true, contextLine: 'bundled()' };
}

describe('isBundledFrame', () => {
  it('recognizes the bundle Cloudflare uploads', () => {
    assert.equal(isBundledFrame(frame('worker.js')), true);
    assert.equal(isBundledFrame(frame('/worker.js')), true);
  });

  it('ignores frames that already point at source', () => {
    assert.equal(isBundledFrame(frame('src/worker.ts')), false);
    assert.equal(isBundledFrame(frame('src/agent/git.ts')), false);
  });
});

describe('resolveFrames', () => {
  it('rewrites a bundled frame into the source frame it came from', () => {
    const frames = resolveFrames(ROOT, [frame('worker.js', 1, 0)], {
      loadMap: () => mapOf('src/worker.ts'),
    });

    assert.equal(frames.length, 1);
    assert.equal(frames[0]?.filename, 'src/worker.ts');
    assert.equal(frames[0]?.lineNo, 10);
    // The bundled line no longer describes anything.
    assert.equal(frames[0]?.contextLine, undefined);
    assert.equal(frames[0]?.fn, 'fetch');
  });

  it('accepts absolute sources inside the repository', () => {
    const frames = resolveFrames(ROOT, [frame('worker.js', 1, 0)], {
      loadMap: () => mapOf('/repo/src/server/app.ts'),
    });

    assert.equal(frames[0]?.filename, 'src/server/app.ts');
  });

  it('leaves an already-resolved stack alone without building anything', () => {
    let loaded = false;
    const input = [frame('src/worker.ts', 42)];
    const frames = resolveFrames(ROOT, input, {
      loadMap: () => {
        loaded = true;
        return mapOf('src/worker.ts');
      },
    });

    assert.equal(loaded, false);
    assert.deepEqual(frames, input);
  });

  it('returns the original frames when the bundle cannot be built', () => {
    const input = [frame('worker.js', 1, 0)];
    const frames = resolveFrames(ROOT, input, { loadMap: () => null });

    assert.deepEqual(frames, input);
  });

  it('drops frames that belong to the SDK rather than the bug', () => {
    const input = [frame('worker.js', 1, 0)];
    const frames = resolveFrames(ROOT, input, {
      loadMap: () => mapOf('node_modules/@sentry/core/build/esm/index.js'),
    });

    // Nothing maps into `src/`, so the caller keeps the bundled stack.
    assert.deepEqual(frames, input);
  });

  it('drops a bundled frame with no line number', () => {
    const frames = resolveFrames(ROOT, [frame('worker.js'), frame('src/worker.ts', 5)], {
      loadMap: () => mapOf('src/worker.ts'),
    });

    assert.equal(frames.length, 1);
    assert.equal(frames[0]?.filename, 'src/worker.ts');
  });
});
