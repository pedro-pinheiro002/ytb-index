/**
 * Channel-input validation for the operator API (`server/api/channel-input`).
 *
 * Deliberately does NOT import `src/yt/parse-channel.ts`: the server import
 * graph must never pull the ingest pipeline (ADR-0002/0003 boundary). The
 * accepted shapes are kept byte-for-byte identical to the CLI parser, so every
 * input this module accepts can be re-parsed by `pnpm ingest <channel>` on the
 * Actions runner — otherwise a dispatch would succeed and the ingest would
 * fail with a `UsageError`.
 *
 * Accepted shapes (spec §5 "Input parser"):
 *   - `@handle` or bare `handle`              -> key `@handle` (lowercased)
 *   - `UC…` 24-char channel ID literal        -> key `UC…` (verbatim)
 *   - `https://[www.]youtube.com/channel/UC…` -> key `UC…`
 *   - `https://[www.]youtube.com/@handle`     -> key `@handle` (lowercased)
 *
 * The key is the one-active-IngestRequest-per-Channel identity
 * (`ingest_requests.channel_key`): UC… id when derivable, else lowercased
 * `@handle`, so `@MKBHD`, `mkbhd`, and the handle URL all collide.
 */

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

/** Result of {@link normalizeChannelInput}. */
export type ChannelKeyResult = { ok: true; channelKey: string } | { ok: false; error: string };

/**
 * Validate one raw channel input and derive its `channel_key`.
 *
 * Whitespace anywhere is invalid (mirrors the CLI: trimming would hide user
 * mistakes); a `UC…`-looking token that fails the exact id shape is a
 * malformed id, not a handle.
 */
export function normalizeChannelInput(raw: string): ChannelKeyResult {
  if (raw === '' || /\s/.test(raw)) {
    return { ok: false, error: `unrecognised channel input: "${describeInput(raw)}"` };
  }

  // 1. URL forms first (most specific).
  const [, channelId] = CHANNEL_URL.exec(raw) ?? [];
  if (channelId !== undefined) {
    return { ok: true, channelKey: channelId };
  }

  const [, handleFromUrl] = HANDLE_URL.exec(raw) ?? [];
  if (handleFromUrl !== undefined) {
    return { ok: true, channelKey: `@${handleFromUrl.toLowerCase()}` };
  }

  // 2. Explicitly `@`-prefixed handle.
  if (AT_HANDLE.test(raw)) {
    return { ok: true, channelKey: raw.toLowerCase() };
  }

  // 3. Channel ID literal. Checked before the bare-handle rule because a
  // valid ID also matches `^[A-Za-z0-9_-]+$`.
  if (CHANNEL_ID.test(raw)) {
    return { ok: true, channelKey: raw };
  }

  // 4. Bare handle — normalise to a lowercased `@handle`.
  if (BARE_HANDLE.test(raw)) {
    if (raw.startsWith('UC')) {
      return { ok: false, error: `unrecognised channel input: "${describeInput(raw)}"` };
    }
    return { ok: true, channelKey: `@${raw.toLowerCase()}` };
  }

  // 5. Nothing matched.
  return { ok: false, error: `unrecognised channel input: "${describeInput(raw)}"` };
}
