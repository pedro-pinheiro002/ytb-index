/**
 * Repository rules for the repair agent (`src/agent/rules`).
 *
 * The style and boundary rules the model must follow are the same ones every
 * other agent reads: the block of `AGENTS.md` between the `agent-rules`
 * markers. Reading them at run time keeps one source of truth, so a rule
 * changed for interactive agents also changes what the repair agent is told.
 *
 * `AGENTS.md` is repository content checked into the default branch (the
 * workflow only runs from it), not event data, so it is trusted like the
 * rest of the prompt.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const RULES_START = '<!-- agent-rules:start -->';
export const RULES_END = '<!-- agent-rules:end -->';

/** The text between the markers, trimmed; `undefined` when they are missing. */
export function extractRules(markdown: string): string | undefined {
  const start = markdown.indexOf(RULES_START);
  const end = markdown.indexOf(RULES_END);
  if (start === -1 || end === -1 || end < start) {
    return undefined;
  }
  const rules = markdown.slice(start + RULES_START.length, end).trim();
  return rules === '' ? undefined : rules;
}

/** Read the rules block from `<repoRoot>/AGENTS.md`; throws when it is absent. */
export function readRepoRules(repoRoot: string): string {
  const rules = extractRules(readFileSync(join(repoRoot, 'AGENTS.md'), 'utf8'));
  if (rules === undefined) {
    throw new Error(`AGENTS.md has no ${RULES_START} … ${RULES_END} block`);
  }
  return rules;
}
