/**
 * Seal → unseal round trip (F6 #51, ADR-0008).
 *
 * The seal format is written in `server/api/seal.ts` and read in
 * `cli/unseal.ts`; neither may import the other, so this test (tests may
 * cross modules) pins that both sides agree, using a freshly generated pair.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sealOperatorKey } from '../server/api/seal.ts';
import { unsealOperatorKey } from './unseal.ts';

const OPERATOR_KEY = `AIza${'r'.repeat(35)}`;

async function keyPair(): Promise<{ publicJwk: string; privateJwk: string }> {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSA-OAEP',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['encrypt', 'decrypt'],
  );
  return {
    publicJwk: JSON.stringify(await crypto.subtle.exportKey('jwk', pair.publicKey)),
    privateJwk: JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey)),
  };
}

describe('OperatorKey sealing', () => {
  it('round-trips server seal → cli unseal in the v1 format', async () => {
    const { publicJwk, privateJwk } = await keyPair();
    const sealed = await sealOperatorKey(OPERATOR_KEY, publicJwk);
    assert.match(sealed, /^v1\.[A-Za-z0-9_-]+$/);
    assert.ok(!sealed.includes(OPERATOR_KEY));
    assert.equal(await unsealOperatorKey(sealed, privateJwk), OPERATOR_KEY);
  });

  it('is randomized: sealing twice gives different ciphertexts', async () => {
    const { publicJwk } = await keyPair();
    assert.notEqual(
      await sealOperatorKey(OPERATOR_KEY, publicJwk),
      await sealOperatorKey(OPERATOR_KEY, publicJwk),
    );
  });

  it('refuses another pair, an unknown format, and a public JWK as the private key', async () => {
    const first = await keyPair();
    const second = await keyPair();
    const sealed = await sealOperatorKey(OPERATOR_KEY, first.publicJwk);
    await assert.rejects(unsealOperatorKey(sealed, second.privateJwk), /could not be opened/);
    await assert.rejects(unsealOperatorKey('v2.abc', first.privateJwk), /unknown format/);
    await assert.rejects(unsealOperatorKey(sealed, first.publicJwk), /not a private JWK/);
  });

  it('refuses to seal under a private JWK', async () => {
    const { privateJwk } = await keyPair();
    await assert.rejects(sealOperatorKey(OPERATOR_KEY, privateJwk), /must be a public JWK/);
  });
});
