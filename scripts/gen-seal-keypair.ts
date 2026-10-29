/**
 * Generate the OperatorKey sealing key pair (ADR-0008, F6 #51).
 *
 * Prints an RSA-OAEP-256 (2048-bit, SHA-256) key pair as one-line JWKs:
 *  - the PUBLIC JWK goes in `wrangler.jsonc` → `vars.INGEST_SEAL_PUBLIC_KEY`
 *    (public by design; the Worker seals OperatorKeys with it);
 *  - the PRIVATE JWK goes in the repo secret `INGEST_SEAL_PRIVATE_KEY`
 *    (the ingest workflow unseals with it). Never commit it.
 *
 * Usage: `pnpm exec tsx scripts/gen-seal-keypair.ts`. Rotating means running
 * it again and replacing both values. Node WebCrypto only; no dependencies.
 */
const pair = await globalThis.crypto.subtle.generateKey(
  {
    name: 'RSA-OAEP',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  },
  true,
  ['encrypt', 'decrypt'],
);

const publicJwk = JSON.stringify(await globalThis.crypto.subtle.exportKey('jwk', pair.publicKey));
const privateJwk = JSON.stringify(await globalThis.crypto.subtle.exportKey('jwk', pair.privateKey));

process.stdout.write(
  [
    '# Public JWK -> wrangler.jsonc vars.INGEST_SEAL_PUBLIC_KEY (paste as the value):',
    publicJwk,
    '',
    '# Private JWK -> repo secret INGEST_SEAL_PRIVATE_KEY, e.g.',
    '#   gh secret set INGEST_SEAL_PRIVATE_KEY   (then paste the line below)',
    privateJwk,
    '',
  ].join('\n'),
);
