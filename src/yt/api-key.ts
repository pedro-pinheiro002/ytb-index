/**
 * API-key shape validation for `YOUTUBE_API_KEY`.
 *
 * Source of decisions: wayfinder #11 + spec §8.
 *
 * Two synchronous local checks:
 *  1. Presence — non-empty after `.trim()`.
 *  2. Shape — match `^AIza[A-Za-z0-9_-]{30,50}$`.
 *
 * Lives in `src/yt/` (it knows YouTube key shape); `shared/` is for types only.
 * Pure — no I/O, no globals.
 */

export type ApiKeyValidation = { ok: true } | { ok: false; reason: 'missing' | 'malformed' };

const KEY_SHAPE = /^AIza[A-Za-z0-9_-]{30,50}$/;

export function validateApiKey(key: string | undefined): ApiKeyValidation {
  if (key === undefined || key.trim() === '') {
    return { ok: false, reason: 'missing' };
  }
  if (!KEY_SHAPE.test(key)) {
    return { ok: false, reason: 'malformed' };
  }
  return { ok: true };
}

/** Stderr message paired with each `reason`. Spec §8. */
export const API_KEY_FAILURE_MESSAGES = {
  missing: 'Error: YOUTUBE_API_KEY is not set. Add it to your .env file.',
  malformed:
    'Error: YOUTUBE_API_KEY has unexpected format (expected "AIza" + ~39 chars). Check the value in .env.',
} as const;
