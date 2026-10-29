/**
 * Operator bearer-token check (`server/api/operator-auth`).
 *
 * Every operator write (`POST /api/ingest`, ADR-0005) and the OperatorKey
 * check (`POST /api/key/check`, ADR-0007, F6 #51) is gated by the same
 * `OPERATOR_TOKEN`, so the constant-time comparison lives here once.
 * Runtime globals only (TextEncoder), so it bundles for Workers.
 */

/**
 * Constant-time string equality: every byte pair is folded into one
 * accumulator and the loop always runs over `max(a.length, b.length)`, so
 * neither content nor an early mismatch is observable through timing. Length
 * is not hidden, which is standard for bearer-token checks.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  const length = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;
  for (let index = 0; index < length; index += 1) {
    diff |= (aBytes[index] ?? 0) ^ (bBytes[index] ?? 0);
  }
  return diff === 0;
}

/**
 * True when `header` is `Bearer <expected>` and `expected` is configured.
 * A missing/empty `OPERATOR_TOKEN` rejects every request (fail closed).
 */
export function isOperatorAuthorized(
  header: string | undefined,
  expected: string | undefined,
): boolean {
  if (expected === undefined || expected === '') {
    return false;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
  if (match === null) {
    return false;
  }
  return constantTimeEqual(match[1] ?? '', expected);
}
