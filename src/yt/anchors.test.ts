/**
 * Table-driven tests for `detectAnchors`. Issue #15 / wayfinder #7.
 *
 * Run via `pnpm test` (node:test runner).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectAnchors, type Anchor } from './anchors.ts';

/** Shorthand for an expected anchor, keeping the tables readable. */
const a = (seconds: number, raw_text: string, char_position: number): Anchor => ({
  seconds,
  raw_text,
  char_position,
});

describe('detectAnchors', () => {
  describe('h:mm:ss (matched anywhere)', () => {
    const cases: Array<{ name: string; input: string; expected: Anchor[] }> = [
      { name: 'bare 1:23:45', input: '1:23:45', expected: [a(5025, '1:23:45', 0)] },
      {
        name: '1:23:45 embedded in prose',
        input: 'check 1:23:45 here',
        expected: [a(5025, '1:23:45', 6)],
      },
      { name: 'leading 0:00:01', input: '0:00:01', expected: [a(1, '0:00:01', 0)] },
      { name: '24:00:00 (upper bound)', input: '24:00:00', expected: [a(86400, '24:00:00', 0)] },
      { name: '25:00:00 rejected (> 24h)', input: '25:00:00', expected: [] },
    ];
    for (const tc of cases) {
      it(tc.name, () => {
        assert.deepEqual(detectAnchors(tc.input), tc.expected);
      });
    }
  });

  describe('mm:ss sentinels (each captures only the anchored timestamp)', () => {
    const cases: Array<{ name: string; input: string; expected: Anchor[] }> = [
      { name: 'at', input: 'at 5:32', expected: [a(332, '5:32', 3)] },
      // The locked `\b(?:at|@)` requires a preceding word char before `@`
      // (JS \b is between \w and non-\w), so a leading-space "@ 1:00" cannot match.
      { name: '@', input: 'look here@ 1:00', expected: [a(60, '1:00', 11)] },
      { name: 'jump to', input: 'jump to 1:00', expected: [a(60, '1:00', 8)] },
      { name: 'skip to', input: 'skip to 1:00', expected: [a(60, '1:00', 8)] },
      { name: 'go to', input: 'go to 1:00', expected: [a(60, '1:00', 6)] },
      { name: 'fast forward to', input: 'fast forward to 1:00', expected: [a(60, '1:00', 16)] },
      { name: 'fast-forward to', input: 'fast-forward to 1:00', expected: [a(60, '1:00', 16)] },
      { name: 'jump until', input: 'jump until 3:00', expected: [a(180, '3:00', 11)] },
      { name: 'the X mark', input: 'the 5:32 mark', expected: [a(332, '5:32', 4)] },
      { name: 'is the X', input: '5:32 is the best', expected: [a(332, '5:32', 0)] },
      { name: 'is where', input: '5:32 is where', expected: [a(332, '5:32', 0)] },
      { name: 'is when', input: '5:32 is when', expected: [a(332, '5:32', 0)] },
      { name: 'from', input: 'from 5:32', expected: [a(332, '5:32', 5)] },
      { name: 'by', input: 'by 5:32', expected: [a(332, '5:32', 3)] },
      { name: 'X onwards', input: '5:32 onwards', expected: [a(332, '5:32', 0)] },
      { name: 'X forward', input: '5:32 forward', expected: [a(332, '5:32', 0)] },
      {
        name: 'range X to Y (only X captured)',
        input: '5:32 to 6:00',
        expected: [a(332, '5:32', 0)],
      },
      { name: 'at 0:00', input: 'at 0:00', expected: [a(0, '0:00', 3)] },
    ];
    for (const tc of cases) {
      it(tc.name, () => {
        assert.deepEqual(detectAnchors(tc.input), tc.expected);
      });
    }
  });

  describe('multiple anchors and de-duplication', () => {
    it('returns all anchors, sorted by char_position', () => {
      assert.deepEqual(detectAnchors('at 1:30 and jump to 2:45'), [
        a(90, '1:30', 3),
        a(165, '2:45', 20),
      ]);
    });

    it('dedupes equal seconds, keeping the earliest char_position', () => {
      assert.deepEqual(detectAnchors('at 5:00 and go to 5:00'), [a(300, '5:00', 3)]);
    });

    it('sorts anchors by position even when regex families interleave', () => {
      assert.deepEqual(detectAnchors('go to 0:30 then at 2:00'), [
        a(30, '0:30', 6),
        a(120, '2:00', 19),
      ]);
    });
  });

  describe('negative cases', () => {
    const cases: Array<{ name: string; input: string }> = [
      { name: 'bare 5:32 (no sentinel)', input: '5:32' },
      { name: 'empty string', input: '' },
      { name: 'only punctuation', input: '...!!! ???' },
      { name: 'ratio 16:9 is not a timestamp', input: 'rendered at 16:9 aspect' },
      { name: 'is 5:32 with no trailing sentinel word', input: 'it is 5:32 now' },
    ];
    for (const tc of cases) {
      it(tc.name, () => {
        assert.deepEqual(detectAnchors(tc.input), []);
      });
    }

    it('does NOT filter timestamps inside code blocks (out of v1 scope)', () => {
      assert.deepEqual(detectAnchors('```\nat 1:00\n```'), [a(60, '1:00', 7)]);
    });
  });
});
