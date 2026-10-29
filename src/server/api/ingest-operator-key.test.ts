/**
 * Integration tests for OperatorKey triggers on `POST /api/ingest`
 * (F6 #51, ADR-0007/0008).
 *
 * The real app (`createApp`) runs over a fresh `:memory:` catalog with two
 * injected transports: the YouTube key probe and the GitHub dispatch. A real
 * RSA-OAEP key pair is generated per run, so sealing is exercised for real.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openCatalog, type SqliteExecutor } from '../../db/sqlite.ts';
import { createApp } from '../app.ts';
import type { DispatchTransport } from './github-dispatch.ts';
import type { KeyCheckTransport } from './key-check.ts';

const OPERATOR_TOKEN = 'test-operator-token';
const OPERATOR_KEY = `AIza${'p'.repeat(35)}`;

/** Fresh RSA-OAEP-256 public JWK (JSON text), as `scripts/gen-seal-keypair.ts` makes. */
async function publicJwk(): Promise<string> {
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
  return JSON.stringify(await crypto.subtle.exportKey('jwk', pair.publicKey));
}

function keyProbe(reply: Response): { transport: KeyCheckTransport; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    transport: async (url) => {
      urls.push(url);
      return reply.clone();
    },
  };
}

function dispatchDouble(): { transport: DispatchTransport; bodies: string[] } {
  const bodies: string[] = [];
  return {
    bodies,
    transport: async (_url, init) => {
      bodies.push(String(init.body));
      return new Response(null, { status: 204 });
    },
  };
}

const KEY_OK = new Response(JSON.stringify({ items: [{ id: 'UC_x5XG1OV2P6uZZ5FSM9Ttw' }] }));
const KEY_INVALID = new Response(
  JSON.stringify({
    error: {
      code: 400,
      message: 'API key not valid. Please pass a valid API key.',
      errors: [{ message: 'API key not valid.', domain: 'global', reason: 'badRequest' }],
      status: 'INVALID_ARGUMENT',
      details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }],
    },
  }),
  { status: 400 },
);

async function setup(options: {
  sealPublicKey?: string;
  probe: KeyCheckTransport;
  dispatch: DispatchTransport;
}): Promise<{ app: Awaited<ReturnType<typeof createApp>>; db: SqliteExecutor }> {
  const db = await openCatalog(':memory:');
  const app = await createApp({
    db,
    ingest: {
      operatorToken: OPERATOR_TOKEN,
      dispatchPat: 'ghp_test',
      ghOwner: 'owner',
      ghRepo: 'repo',
      transport: options.dispatch,
      keyCheckTransport: options.probe,
      sealPublicKey: options.sealPublicKey,
      uuid: () => 'req-1',
    },
  });
  return { app, db };
}

async function post(app: Awaited<ReturnType<typeof createApp>>, body: unknown): Promise<Response> {
  return await app.request('/api/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${OPERATOR_TOKEN}` },
    body: JSON.stringify(body),
  });
}

async function rows(
  db: SqliteExecutor,
): Promise<Array<{ id: string; key_source: string; capture_live_chat: number }>> {
  return db.all('SELECT id, key_source, capture_live_chat FROM ingest_requests');
}

describe('POST /api/ingest with an OperatorKey', () => {
  it('seals the key, records key_source=operator, and dispatches only the ciphertext', async () => {
    const probe = keyProbe(KEY_OK);
    const dispatch = dispatchDouble();
    const { app, db } = await setup({
      sealPublicKey: await publicJwk(),
      probe: probe.transport,
      dispatch: dispatch.transport,
    });
    try {
      const res = await post(app, { channel: '@mkbhd', key: OPERATOR_KEY, captureLiveChat: true });
      assert.equal(res.status, 202);
      assert.deepEqual(await res.json(), { requestId: 'req-1' });
      assert.equal(probe.urls.length, 1, 'the key is checked once before sealing');

      assert.equal(dispatch.bodies.length, 1);
      const body = dispatch.bodies[0] ?? '';
      assert.ok(!body.includes(OPERATOR_KEY), 'the plaintext key never leaves in the dispatch');
      const payload = (JSON.parse(body) as { client_payload: Record<string, unknown> })
        .client_payload;
      assert.equal(payload['requestId'], 'req-1');
      assert.equal(payload['channel'], '@mkbhd');
      assert.equal(payload['captureLiveChat'], true);
      assert.match(String(payload['sealedKey']), /^v1\.[A-Za-z0-9_-]+$/);

      assert.deepEqual(await rows(db), [
        { id: 'req-1', key_source: 'operator', capture_live_chat: 1 },
      ]);
      const stored = JSON.stringify(await db.all('SELECT * FROM ingest_requests'));
      assert.ok(!stored.includes(OPERATOR_KEY), 'the key is never written to the catalog');
    } finally {
      db.close();
    }
  });

  it('answers 422 with the verdict and creates no IngestRequest when the key is refused', async () => {
    const dispatch = dispatchDouble();
    const { app, db } = await setup({
      sealPublicKey: await publicJwk(),
      probe: keyProbe(KEY_INVALID).transport,
      dispatch: dispatch.transport,
    });
    try {
      const res = await post(app, { channel: '@mkbhd', key: OPERATOR_KEY });
      assert.equal(res.status, 422);
      const body = (await res.json()) as { reason: string; message: string };
      assert.equal(body.reason, 'invalid');
      assert.ok(body.message.length > 0);
      assert.deepEqual(await rows(db), []);
      assert.equal(dispatch.bodies.length, 0);

      const malformed = await post(app, { channel: '@mkbhd', key: 'nope' });
      assert.equal(malformed.status, 422);
      assert.equal(((await malformed.json()) as { reason: string }).reason, 'malformed');
      assert.deepEqual(await rows(db), []);
    } finally {
      db.close();
    }
  });

  it('fails closed with 503 and no row when INGEST_SEAL_PUBLIC_KEY is not configured', async () => {
    const probe = keyProbe(KEY_OK);
    const dispatch = dispatchDouble();
    const { app, db } = await setup({ probe: probe.transport, dispatch: dispatch.transport });
    try {
      const res = await post(app, { channel: '@mkbhd', key: OPERATOR_KEY });
      assert.equal(res.status, 503);
      assert.ok(typeof ((await res.json()) as { error: unknown }).error === 'string');
      assert.deepEqual(await rows(db), []);
      assert.equal(dispatch.bodies.length, 0);
      assert.equal(probe.urls.length, 0);
    } finally {
      db.close();
    }
  });

  it('without a key, the repo key pays and nothing is probed or sealed', async () => {
    const probe = keyProbe(KEY_OK);
    const dispatch = dispatchDouble();
    const { app, db } = await setup({ probe: probe.transport, dispatch: dispatch.transport });
    try {
      const res = await post(app, { channel: '@mkbhd' });
      assert.equal(res.status, 202);
      assert.equal(probe.urls.length, 0);
      const payload = (JSON.parse(dispatch.bodies[0] ?? '{}') as { client_payload: object })
        .client_payload;
      assert.deepEqual(payload, { requestId: 'req-1', channel: '@mkbhd', captureLiveChat: false });
      assert.deepEqual(await rows(db), [{ id: 'req-1', key_source: 'repo', capture_live_chat: 0 }]);
    } finally {
      db.close();
    }
  });

  it('rejects a non-boolean captureLiveChat with 400', async () => {
    const dispatch = dispatchDouble();
    const { app, db } = await setup({
      probe: keyProbe(KEY_OK).transport,
      dispatch: dispatch.transport,
    });
    try {
      assert.equal((await post(app, { channel: '@mkbhd', captureLiveChat: 'yes' })).status, 400);
      assert.deepEqual(await rows(db), []);
    } finally {
      db.close();
    }
  });
});
