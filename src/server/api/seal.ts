/**
 * OperatorKey sealing (`server/api/seal`), F6 (#51), ADR-0008.
 *
 * The Worker never stores or dispatches an OperatorKey in plaintext: it
 * encrypts the key with RSA-OAEP / SHA-256 under the public JWK held in the
 * `INGEST_SEAL_PUBLIC_KEY` Worker var, and only the ciphertext travels in the
 * `repository_dispatch` `client_payload`. The Actions runner opens it with the
 * matching private key (`src/cli/unseal.ts`).
 *
 * Seal format (pinned by `src/cli/unseal.test.ts`, a cross-module round trip,
 * because `server` and `cli` may not import each other):
 *
 *     v1.<base64url(RSA-OAEP-SHA256 ciphertext), no padding>
 *
 * WebCrypto (`globalThis.crypto.subtle`) plus `btoa` only, so it runs in the
 * Worker and in Node 24 alike, with no `Buffer` and no `node:*` import.
 */

/** Prefix of every sealed OperatorKey; bump it when the scheme changes. */
export const SEAL_FORMAT_PREFIX = 'v1.';

const RSA_OAEP = { name: 'RSA-OAEP', hash: 'SHA-256' } as const;

/** The RSA JWK members used here (the tsconfig lib has no DOM `JsonWebKey`). */
interface RsaJwk {
  kty?: string;
  n?: string;
  e?: string;
  alg?: string;
  ext?: boolean;
  key_ops?: string[];
  /** Private exponent: present only on a private JWK. */
  d?: string;
}

/** Unpadded base64url of `bytes`. */
function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Seal `key` under `publicJwk` (the JSON text of an RSA public JWK).
 * Throws when the JWK cannot be parsed or imported; callers fail closed.
 */
export async function sealOperatorKey(key: string, publicJwk: string): Promise<string> {
  const jwk = JSON.parse(publicJwk) as RsaJwk;
  if (jwk.d !== undefined) {
    // A private JWK pasted into the public var would publish the secret.
    throw new Error('INGEST_SEAL_PUBLIC_KEY must be a public JWK (it has a private "d" member)');
  }
  // Import as a public encryption key regardless of the JWK's own `key_ops`.
  const { key_ops: _keyOps, ...publicOnly } = jwk;
  const cryptoKey = await globalThis.crypto.subtle.importKey('jwk', publicOnly, RSA_OAEP, false, [
    'encrypt',
  ]);
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    RSA_OAEP,
    cryptoKey,
    new TextEncoder().encode(key),
  );
  return `${SEAL_FORMAT_PREFIX}${toBase64Url(new Uint8Array(ciphertext))}`;
}
