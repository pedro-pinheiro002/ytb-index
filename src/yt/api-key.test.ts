/**
 * Table-driven tests for `validateApiKey`. Spec §8.
 *
 * Run via `pnpm test` (node:test runner).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateApiKey } from './api-key.ts';

const VALID_KEY = 'AIza' + 'A'.repeat(35); // 39 chars total

describe('validateApiKey', () => {
  const cases: Array<{
    name: string;
    input: string | undefined;
    expected: { ok: true } | { ok: false; reason: 'missing' | 'malformed' };
  }> = [
    { name: 'undefined → missing', input: undefined, expected: { ok: false, reason: 'missing' } },
    { name: 'empty string → missing', input: '', expected: { ok: false, reason: 'missing' } },
    {
      name: 'whitespace-only → missing',
      input: '   \t\n',
      expected: { ok: false, reason: 'missing' },
    },
    {
      name: 'valid AIza + 35 chars → ok',
      input: VALID_KEY,
      expected: { ok: true },
    },
    {
      name: 'AIza prefix only → malformed',
      input: 'AIza',
      expected: { ok: false, reason: 'malformed' },
    },
    {
      name: 'AIza + 29 chars (too short) → malformed',
      input: 'AIza' + 'A'.repeat(29),
      expected: { ok: false, reason: 'malformed' },
    },
    {
      name: 'AIza + 51 chars (too long) → malformed',
      input: 'AIza' + 'A'.repeat(51),
      expected: { ok: false, reason: 'malformed' },
    },
    {
      name: 'AIza + 30 chars (lower bound) → ok',
      input: 'AIza' + 'A'.repeat(30),
      expected: { ok: true },
    },
    {
      name: 'AIza + 50 chars (upper bound) → ok',
      input: 'AIza' + 'A'.repeat(50),
      expected: { ok: true },
    },
    {
      name: 'wrong prefix → malformed',
      input: 'BIza' + 'A'.repeat(35),
      expected: { ok: false, reason: 'malformed' },
    },
    {
      name: 'AIza + invalid character → malformed',
      input: 'AIza' + 'A'.repeat(34) + '!',
      expected: { ok: false, reason: 'malformed' },
    },
    {
      name: 'AIza + allowed punctuation (-_) → ok',
      input: 'AIza' + 'A'.repeat(33) + '-_',
      expected: { ok: true },
    },
  ];

  for (const tc of cases) {
    it(tc.name, () => {
      assert.deepEqual(validateApiKey(tc.input), tc.expected);
    });
  }

  it('returns missing for a value whose trimmed form is empty', () => {
    assert.deepEqual(validateApiKey('   '), { ok: false, reason: 'missing' });
  });
});
