/**
 * Channel input parser — spec §5 "Input parser".
 *
 * Normalises the channel shapes a CLI user can paste into a discriminated
 * `ChannelInput`:
 *
 *   - `@handle` or bare `handle`              → `{ kind: 'handle', value: '@handle' }`
 *   - `UC…` 24-char channel ID literal        → `{ kind: 'id', value: 'UC…' }`
 *   - `https://[www.]youtube.com/channel/UC…` → `{ kind: 'id', value: 'UC…' }`
 *   - `https://[www.]youtube.com/@handle`     → `{ kind: 'handle', value: '@handle' }`
 *
 * Anything else throws a `UsageError` naming the offending input. Pure — no
 * I/O, no globals.
 */

import type { ChannelInput } from '../shared/types.ts';

export type { ChannelInput } from '../shared/types.ts';

/** Thrown when the CLI receives channel input that matches no known shape. Spec §5. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** 24 chars total: `UC` + 22 URL-safe chars. */
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

/** A bare handle: alphanumeric plus `-` and `_`, at least one char. */
const BARE_HANDLE = /^[A-Za-z0-9_-]+$/;

/** An `@`-prefixed handle with at least one char after the `@`. */
const AT_HANDLE = /^@[A-Za-z0-9_-]+$/;

/** `https://[www.]youtube.com/channel/UC…`, trailing slash tolerated. */
const CHANNEL_URL = /^https:\/\/(?:www\.)?youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})\/?$/;

/** `https://[www.]youtube.com/@handle`, trailing slash tolerated. */
const HANDLE_URL = /^https:\/\/(?:www\.)?youtube\.com\/@([A-Za-z0-9_-]+)\/?$/;

const MAX_ECHO = 80;

/** Echo the bad input, truncating very long values so errors stay readable. */
function describeInput(raw: string): string {
  return raw.length > MAX_ECHO ? `${raw.slice(0, MAX_ECHO)}…` : raw;
}

function usageError(raw: string): UsageError {
  return new UsageError(`unrecognised channel input: "${describeInput(raw)}"`);
}

/**
 * Parse a single channel argument. See file header for accepted shapes.
 *
 * @throws {UsageError} when `raw` matches none of the accepted shapes.
 */
export function parseChannelInput(raw: string): ChannelInput {
  // Any whitespace — leading, trailing, or internal — is invalid: handles and
  // IDs never contain it, and trimming silently would hide user mistakes.
  if (raw === '' || /\s/.test(raw)) {
    throw usageError(raw);
  }

  // 1. URL forms first (most specific).
  const [, channelId] = CHANNEL_URL.exec(raw) ?? [];
  if (channelId !== undefined) {
    return { kind: 'id', value: channelId };
  }

  const [, handleFromUrl] = HANDLE_URL.exec(raw) ?? [];
  if (handleFromUrl !== undefined) {
    return { kind: 'handle', value: `@${handleFromUrl}` };
  }

  // 2. Explicitly `@`-prefixed handle.
  if (AT_HANDLE.test(raw)) {
    return { kind: 'handle', value: raw };
  }

  // 3. Channel ID literal. Checked before the bare-handle rule because a
  // valid ID also matches `^[A-Za-z0-9_-]+$`.
  if (CHANNEL_ID.test(raw)) {
    return { kind: 'id', value: raw };
  }

  // 4. Bare handle — normalise with a leading `@`.
  if (BARE_HANDLE.test(raw)) {
    // A `UC…`-looking token that failed the exact ID shape is a malformed ID,
    // not a handle; reject rather than silently normalising it.
    if (raw.startsWith('UC')) {
      throw usageError(raw);
    }
    return { kind: 'handle', value: `@${raw}` };
  }

  // 5. Nothing matched.
  throw usageError(raw);
}
