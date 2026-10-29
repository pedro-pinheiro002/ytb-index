/**
 * OperatorKey unsealing (`cli/unseal`), F6 (#51), ADR-0008.
 *
 * The Worker seals an OperatorKey under a public RSA-OAEP / SHA-256 JWK
 * (`src/server/api/seal.ts`); the Actions runner opens it here with the
 * private JWK held in the `INGEST_SEAL_PRIVATE_KEY` repo secret. Format:
 *
 *     v1.<base64url(RSA-OAEP-SHA256 ciphertext), no padding>
 *
 * `cli` and `server` may not import each other, so the format is written
 * twice and pinned by the round-trip test in `./unseal.test.ts`.
 * WebCrypto only (`globalThis.crypto.subtle`). The plaintext is returned to the
 * caller and never logged.
 */

const SEAL_FORMAT_PREFIX = 'v1.';
const RSA_OAEP = { name: 'RSA-OAEP', hash: 'SHA-256' } as const;

/** The RSA JWK members used here (the tsconfig lib has no DOM `JsonWebKey`). */
interface RsaJwk {
  kty?: string;
  d?: string;
  key_ops?: string[];
  [member: string]: unknown;
}

/** Decode unpadded (or padded) base64url. */
function fromBase64Url(text: string): Uint8Array {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * Open a sealed OperatorKey with `privateJwk` (the JSON text of the RSA
 * private JWK). Throws on an unknown format, a bad JWK, or a ciphertext that
 * was not sealed for this key pair; error messages never include the key.
 */
export async function unsealOperatorKey(sealed: string, privateJwk: string): Promise<string> {
  const trimmed = sealed.trim();
  if (!trimmed.startsWith(SEAL_FORMAT_PREFIX)) {
    throw new Error(`sealed OperatorKey has an unknown format (expected "${SEAL_FORMAT_PREFIX}…")`);
  }
  let jwk: RsaJwk;
  try {
    jwk = JSON.parse(privateJwk) as RsaJwk;
  } catch {
    throw new Error('INGEST_SEAL_PRIVATE_KEY is not valid JSON (expected a private JWK)');
  }
  if (jwk.d === undefined) {
    throw new Error('INGEST_SEAL_PRIVATE_KEY is not a private JWK (no "d" member)');
  }
  const { key_ops: _keyOps, ...privateOnly } = jwk;
  const cryptoKey = await globalThis.crypto.subtle.importKey('jwk', privateOnly, RSA_OAEP, false, [
    'decrypt',
  ]);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await globalThis.crypto.subtle.decrypt(
      RSA_OAEP,
      cryptoKey,
      fromBase64Url(trimmed.slice(SEAL_FORMAT_PREFIX.length)),
    );
  } catch {
    throw new Error('sealed OperatorKey could not be opened with INGEST_SEAL_PRIVATE_KEY');
  }
  return new TextDecoder().decode(plaintext);
}

/** Where the Ingest's YouTube API key came from (ADR-0008). */
export type ApiKeyResolution =
  | { ok: true; key: string | undefined; source: 'operator' | 'repo' }
  | { ok: false; message: string };

/**
 * Pick the Ingest's API key from `env`: the unsealed OperatorKey when
 * `INGEST_SEALED_KEY` is set (which then requires `INGEST_SEAL_PRIVATE_KEY`),
 * else `YOUTUBE_API_KEY` (the repo fallback, possibly unset). Shape
 * validation stays with the caller (`validateApiKey`).
 */
export async function resolveIngestApiKey(
  env: Record<string, string | undefined>,
): Promise<ApiKeyResolution> {
  const sealed = env['INGEST_SEALED_KEY'] ?? '';
  if (sealed.trim() === '') {
    return { ok: true, key: env['YOUTUBE_API_KEY'], source: 'repo' };
  }
  const privateJwk = env['INGEST_SEAL_PRIVATE_KEY'] ?? '';
  if (privateJwk.trim() === '') {
    return {
      ok: false,
      message: 'Error: INGEST_SEALED_KEY is set but INGEST_SEAL_PRIVATE_KEY is not.',
    };
  }
  try {
    return { ok: true, key: await unsealOperatorKey(sealed, privateJwk), source: 'operator' };
  } catch (err) {
    return { ok: false, message: `Error: ${err instanceof Error ? err.message : String(err)}` };
  }
}
