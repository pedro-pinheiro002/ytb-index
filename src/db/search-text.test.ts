/**
 * Tests for `normalizeSearchText` (ADR-0010, ticket F1 #47).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSearchText } from './search-text.ts';

describe('normalizeSearchText', () => {
  it('strips diacritics and lowercases', () => {
    assert.equal(normalizeSearchText('Ação'), 'acao');
    assert.equal(normalizeSearchText('Crème Brûlée'), 'creme brulee');
  });

  it('collapses punctuation runs into one space and trims', () => {
    assert.equal(normalizeSearchText('Hello, World!!'), 'hello world');
    assert.equal(normalizeSearchText('  --a...b--  '), 'a b');
  });

  it('collapses emoji and mixed punctuation into one space', () => {
    assert.equal(normalizeSearchText('gg 🔥🔥!! 👏 nice'), 'gg nice');
    assert.equal(normalizeSearchText('5:32\n\tlol'), '5 32 lol');
  });

  it('applies compatibility decomposition (NFKD)', () => {
    assert.equal(normalizeSearchText('ﬁne Ｔｅｓｔ ²'), 'fine test 2');
  });

  it('keeps non-Latin letters and digits', () => {
    assert.equal(normalizeSearchText('Привет, мир 2024'), 'привет мир 2024');
  });

  it('is idempotent', () => {
    for (const input of ['Ação, World!!', 'gg 🔥 nice', 'ﬁne ²', '']) {
      const once = normalizeSearchText(input);
      assert.equal(normalizeSearchText(once), once);
    }
  });

  it('maps empty and separator-only strings to the empty string', () => {
    assert.equal(normalizeSearchText(''), '');
    assert.equal(normalizeSearchText(' !?🔥 '), '');
  });
});
