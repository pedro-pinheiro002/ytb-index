/**
 * Tests for frame normalization in `src/agent/sentry` (ADR-0006).
 *
 * The failure this pins down is silent: `/events/latest/` returns camelCase
 * frames, the ingest payload returns snake_case, and reading only one shape
 * left `lineNo` undefined for every frame — so the agent had a stack trace it
 * could not look anything up for.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fetchLatestEvent } from './sentry.ts';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Answer every request with one event body. */
function stubEvent(body: unknown): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
}

const EVENT = {
  eventID: 'abc',
  title: 'TypeError: x',
  message: 'x',
  platform: 'javascript',
  tags: [],
};

describe('fetchLatestEvent', () => {
  it('reads camelCase frames from /events/latest/', async () => {
    stubEvent({
      ...EVENT,
      entries: [
        {
          type: 'exception',
          data: {
            values: [
              {
                type: 'TypeError',
                value: 'x is not a function',
                stacktrace: {
                  frames: [
                    {
                      filename: '/worker.js',
                      function: 'fetch',
                      lineNo: 17693,
                      colNo: 13,
                      inApp: true,
                      contextLine: 'return getApp(env)',
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    });

    const event = await fetchLatestEvent('https://sentry.example', 'token', '1');
    const [frame] = event.frames;
    assert.equal(frame?.filename, '/worker.js');
    assert.equal(frame?.lineNo, 17693);
    assert.equal(frame?.colNo, 13);
    assert.equal(frame?.inApp, true);
    assert.equal(frame?.contextLine, 'return getApp(env)');
  });

  it('still reads snake_case frames from the ingest shape', async () => {
    stubEvent({
      ...EVENT,
      exception: {
        values: [
          {
            type: 'TypeError',
            value: 'x is not a function',
            stacktrace: {
              frames: [
                {
                  abs_path: '/worker.js',
                  function: 'fetch',
                  lineno: 42,
                  colno: 3,
                  in_app: true,
                  context_line: 'bundled()',
                },
              ],
            },
          },
        ],
      },
    });

    const event = await fetchLatestEvent('https://sentry.example', 'token', '1');
    const [frame] = event.frames;
    assert.equal(frame?.filename, '/worker.js');
    assert.equal(frame?.lineNo, 42);
    assert.equal(frame?.colNo, 3);
    assert.equal(frame?.inApp, true);
    assert.equal(frame?.contextLine, 'bundled()');
  });
});
