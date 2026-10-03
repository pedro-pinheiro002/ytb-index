/**
 * Table-driven tests for `parseChannelInput`. Spec §5.
 *
 * Run via `pnpm test` (node:test runner).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseChannelInput, UsageError } from './parse-channel.ts';
import type { ChannelInput } from './parse-channel.ts';

const VALID_ID = 'UCsXVk37bltHxD1rDPwtNM8Q';

describe('parseChannelInput', () => {
  const accepts: Array<{ name: string; input: string; expected: ChannelInput }> = [
    {
      name: '@handle keeps the leading @',
      input: '@veritasium',
      expected: { kind: 'handle', value: '@veritasium' },
    },
    {
      name: 'bare handle gains a leading @',
      input: 'veritasium',
      expected: { kind: 'handle', value: '@veritasium' },
    },
    {
      name: 'bare handle allows - and _',
      input: 'my_chan-1',
      expected: { kind: 'handle', value: '@my_chan-1' },
    },
    {
      name: '24-char channel ID literal',
      input: VALID_ID,
      expected: { kind: 'id', value: VALID_ID },
    },
    {
      name: 'youtube.com channel URL',
      input: `https://youtube.com/channel/${VALID_ID}`,
      expected: { kind: 'id', value: VALID_ID },
    },
    {
      name: 'www.youtube.com channel URL',
      input: `https://www.youtube.com/channel/${VALID_ID}`,
      expected: { kind: 'id', value: VALID_ID },
    },
    {
      name: 'youtube.com @handle URL',
      input: 'https://youtube.com/@veritasium',
      expected: { kind: 'handle', value: '@veritasium' },
    },
    {
      name: 'www.youtube.com @handle URL',
      input: 'https://www.youtube.com/@veritasium',
      expected: { kind: 'handle', value: '@veritasium' },
    },
  ];

  for (const tc of accepts) {
    it(`accepts ${tc.name}`, () => {
      assert.deepEqual(parseChannelInput(tc.input), tc.expected);
    });
  }

  const rejects: Array<{ name: string; input: string }> = [
    { name: 'empty string', input: '' },
    { name: 'whitespace-only', input: '   ' },
    { name: 'trailing whitespace', input: '@veritasium ' },
    { name: 'leading whitespace', input: ' @veritasium' },
    { name: 'internal whitespace', input: 'hello world' },
    { name: '@ alone', input: '@' },
    { name: 'channel ID too short', input: VALID_ID.slice(0, -1) },
    { name: 'channel ID too long', input: `${VALID_ID}x` },
    { name: 'watch URL', input: 'https://youtube.com/watch?v=dQw4w9WgXcQ' },
    { name: 'malformed URL without an ID', input: 'https://youtube.com/channel/' },
    { name: 'non-youtube URL', input: 'https://example.com/@veritasium' },
    { name: 'http scheme', input: 'http://youtube.com/@veritasium' },
  ];

  for (const tc of rejects) {
    it(`rejects ${tc.name}`, () => {
      assert.throws(() => parseChannelInput(tc.input), UsageError);
    });
  }

  it('reports the offending input in the UsageError message', () => {
    assert.throws(
      () => parseChannelInput('not a channel'),
      (err: unknown) => err instanceof UsageError && err.message.includes('not a channel'),
    );
  });

  it('UsageError is an Error named UsageError', () => {
    const err = new UsageError('boom');
    assert.ok(err instanceof Error);
    assert.equal(err.name, 'UsageError');
    assert.equal(err.message, 'boom');
  });
});
