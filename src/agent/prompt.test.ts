/**
 * Tests for prompt construction (`src/agent/prompt`).
 *
 * Only the contract with `rules.ts` is covered here: the repository rules
 * reach the system message after the fixed rules, so the diff-format rules
 * cannot be displaced by whatever `AGENTS.md` says.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildMessages, SYSTEM_PROMPT, type Incident } from './prompt.ts';

const INCIDENT: Incident = {
  issue: {
    id: '1',
    shortId: 'YTB-INDEX-1',
    title: 'TypeError',
    culprit: 'src/worker.ts',
    level: 'error',
    status: 'unresolved',
    count: '1',
    firstSeen: '2026-10-01T00:00:00Z',
    lastSeen: '2026-10-01T00:00:00Z',
    permalink: 'https://sentry.io/issues/1/',
    metadata: {},
  },
  event: {
    eventId: 'e1',
    title: 'TypeError',
    message: 'boom',
    platform: 'javascript',
    tags: {},
    frames: [],
  },
  files: [],
  rules: '- Named exports only.',
};

describe('buildMessages', () => {
  it('appends the repository rules after the fixed system prompt', () => {
    const [system] = buildMessages(INCIDENT);
    assert.equal(system?.role, 'system');
    assert.ok(system?.content.startsWith(SYSTEM_PROMPT));
    assert.match(
      system?.content ?? '',
      /## Repository rules \(from AGENTS\.md\)\n\n- Named exports only\.$/,
    );
  });
});
