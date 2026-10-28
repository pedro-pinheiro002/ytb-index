/**
 * Tests for diff extraction and the `src/` allowlist (`src/agent/patch`).
 *
 * These are the security-relevant cases: a model (or a prompt-injected issue)
 * must not be able to touch workflows, dependencies, or deployment config from
 * the repair agent. Run via `pnpm test`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { countChangedLines, extractDiff, summarizeDiff, validateDiff } from './patch.ts';

/** A well-formed diff for one file, changing one line. */
function sampleDiff(path = 'src/server/routes/video.ts'): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -10,7 +10,7 @@ export function videoRoute(app: Hono): void {',
    "   const id = c.req.param('videoId');",
    '-  const video = loadVideo(db, id!);',
    '+  const video = id === undefined ? undefined : loadVideo(db, id);',
    '   if (video === undefined) {',
    '     return c.notFound();',
    '   }',
    '',
  ].join('\n');
}

describe('extractDiff', () => {
  it('pulls the fenced diff out of surrounding prose', () => {
    const completion = `Here is the fix.\n\n\`\`\`diff\n${sampleDiff()}\`\`\`\n\nDone.`;
    assert.equal(extractDiff(completion)?.startsWith('diff --git'), true);
  });

  it('accepts a bare diff with no fence', () => {
    assert.equal(extractDiff(sampleDiff())?.startsWith('diff --git'), true);
  });

  it('returns undefined when there is nothing diff-shaped', () => {
    assert.equal(extractDiff('I could not find the bug.'), undefined);
    assert.equal(extractDiff('```diff\n```'), undefined);
  });
});

describe('validateDiff', () => {
  it('accepts a small patch inside src/', () => {
    const result = validateDiff(sampleDiff());
    assert.deepEqual(result, {
      ok: true,
      files: ['src/server/routes/video.ts'],
      changedLines: 2,
    });
  });

  it('rejects paths outside src/', () => {
    const result = validateDiff(sampleDiff('.github/workflows/ci.yml'));
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reasons.join(' ') : '', /path not allowed/);
  });

  it('rejects package.json and wrangler config even under a src-like prefix', () => {
    for (const path of ['package.json', 'wrangler.jsonc', 'src/../.github/workflows/ci.yml']) {
      assert.equal(validateDiff(sampleDiff(path)).ok, false, path);
    }
  });

  it('rejects file creation', () => {
    const creation = [
      'diff --git a/src/agent/new.ts b/src/agent/new.ts',
      '--- /dev/null',
      '+++ b/src/agent/new.ts',
      '@@ -0,0 +1,2 @@',
      '+export const x = 1;',
      '',
    ].join('\n');
    const result = validateDiff(creation);
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reasons.join(' ') : '', /creating files/);
  });

  it('rejects deletions and renames', () => {
    const deletion = sampleDiff().replace('--- a/', 'deleted file mode 100644\n--- a/');
    assert.equal(validateDiff(deletion).ok, false);
  });

  it('rejects diffs above the line budget', () => {
    const lines = Array.from({ length: 30 }, (_, index) => `+const v${index} = ${index};`);
    const big = [
      'diff --git a/src/x.ts b/src/x.ts',
      '--- a/src/x.ts',
      '+++ b/src/x.ts',
      '@@ -1,1 +1,31 @@',
      ...lines,
      '',
    ].join('\n');
    const result = validateDiff(big, 10);
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reasons.join(' ') : '', /too large/);
  });

  it('rejects text that is not a unified diff', () => {
    const result = validateDiff('just some prose\n');
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reasons.join(' ') : '', /no hunk header/);
  });

  it('counts changed lines without the file headers', () => {
    assert.equal(countChangedLines(sampleDiff()), 2);
  });
});

describe('summarizeDiff', () => {
  it('reports files and added/removed counts', () => {
    assert.equal(summarizeDiff(sampleDiff()), '1 file(s), +1/-1');
  });
});
