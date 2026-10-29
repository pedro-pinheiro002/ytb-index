/**
 * Tests for the repository rules block (`src/agent/rules`).
 *
 * The real `AGENTS.md` is read on purpose: deleting or emptying its rules
 * block would silently strip the repair agent's constraints, so that must
 * fail here rather than in a production run.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { extractRules, readRepoRules, RULES_END, RULES_START } from './rules.ts';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

describe('extractRules', () => {
  it('returns the trimmed text between the markers', () => {
    assert.equal(extractRules(`intro\n${RULES_START}\n- rule\n${RULES_END}\nrest`), '- rule');
  });

  it('is undefined when a marker is missing, reversed, or the block is empty', () => {
    assert.equal(extractRules(`${RULES_START}\n- rule`), undefined);
    assert.equal(extractRules(`${RULES_END}\n- rule\n${RULES_START}`), undefined);
    assert.equal(extractRules(`${RULES_START}\n\n${RULES_END}`), undefined);
  });
});

describe('readRepoRules', () => {
  it("reads the repository's AGENTS.md block with the boundary and style rules", () => {
    const rules = readRepoRules(REPO_ROOT);
    assert.match(rules, /process\.env/);
    assert.match(rules, /Worker import graph/);
    assert.match(rules, /Named exports/);
  });
});
