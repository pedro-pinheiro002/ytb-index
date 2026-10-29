/**
 * Tests for SearchHit term highlighting (`./highlight.ts`), F5 (#53) /
 * ADR-0010: matches found on normalized text map back to the original.
 *
 * Run via `pnpm test` (node:test runner).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matchRanges } from './highlight.ts';

function marked(text: string, terms: string[]): string[] {
  return matchRanges(text, terms).map((range) => text.slice(range.start, range.end));
}

describe('matchRanges', () => {
  it('matches case- and accent-insensitively', () => {
    assert.deepEqual(marked('Uma AÇÃO incrível', ['acao', 'incrivel']), ['AÇÃO', 'incrível']);
  });

  it('keeps a decomposed accent with its letter', () => {
    const acute = String.fromCodePoint(0x301);
    assert.deepEqual(marked(`Cafe${acute} au lait`, ['cafe']), [`Cafe${acute}`]);
  });

  it('matches a term across a collapsed separator run', () => {
    assert.deepEqual(marked('rock -- and roll', ['rock and']), ['rock -- and']);
  });

  it('merges overlapping and touching matches, and finds repeats', () => {
    assert.deepEqual(marked('banana bandana', ['ana', 'nan', 'band']), ['anana', 'bandana']);
  });

  it('marks a whole ligature when a term covers part of it', () => {
    assert.deepEqual(marked('the ﬁne print', ['fine']), ['ﬁne']);
  });

  it('finds nothing for terms absent from the text', () => {
    assert.deepEqual(matchRanges('hello world', ['zebra', '']), []);
  });
});
