/**
 * Diff extraction and validation (`src/agent/patch`).
 *
 * This module is the security boundary between "a language model produced
 * text" and "git is allowed to touch the tree". Everything here is pure so it
 * can be tested without a repository, and every rejection is a *reason string*
 * that ends up in the run log and the Telegram message.
 *
 * The rules encode what the agent is allowed to be: a bug-fixer for `src/`,
 * not a way to change CI, dependencies, or deployment configuration. A
 * prompt-injected issue still has to get past this allowlist, then past
 * `pnpm typecheck && pnpm test`, then past a human reviewing a draft PR.
 */
import { isSourcePath } from './context.ts';

/** Result of validating a proposed diff. */
export type DiffValidation =
  { ok: true; files: string[]; changedLines: number } | { ok: false; reasons: string[] };

/** Fence the model is instructed to use. */
const DIFF_FENCE = /```diff\s*\n([\s\S]*?)```/;

/**
 * Pull the diff out of a completion.
 *
 * Accepts the requested fenced block first; falls back to the whole message
 * when it already starts like a diff, and `undefined` when there is nothing
 * diff-shaped to apply.
 */
export function extractDiff(completion: string): string | undefined {
  const fenced = DIFF_FENCE.exec(completion);
  if (fenced !== null) {
    const body = fenced[1];
    return body === undefined || body.trim() === '' ? undefined : body;
  }

  const trimmed = completion.trim();
  if (trimmed.startsWith('diff --git ') || trimmed.startsWith('--- ')) {
    return `${trimmed}\n`;
  }
  return undefined;
}

/** Count changed lines (`+`/`-`, excluding the file headers). */
export function countChangedLines(diff: string): number {
  let count = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) {
      continue;
    }
    if (line.startsWith('+') || line.startsWith('-')) {
      count += 1;
    }
  }
  return count;
}

/** Read `+++ b/<path>` targets; unified diffs always have one per file. */
function targetPaths(diff: string): string[] {
  const paths: string[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const raw = line.slice(4).trim();
      paths.push(raw.replace(/^b\//, '').replace(/\t.*$/, ''));
    }
  }
  return paths;
}

/**
 * Validate a diff against the agent's allowlist.
 *
 * Rejections are cumulative so one run reports every problem at once.
 */
export function validateDiff(diff: string, maxChangedLines = 200): DiffValidation {
  const reasons: string[] = [];

  if (diff.trim() === '') {
    return { ok: false, reasons: ['empty diff'] };
  }
  if (!diff.includes('\n@@ ')) {
    reasons.push('no hunk header (@@) — not a unified diff');
  }
  if (diff.includes('GIT binary patch')) {
    reasons.push('binary patches are not allowed');
  }
  if (/^(rename from|rename to|deleted file mode) /m.test(diff)) {
    reasons.push('renames and deletions are not allowed');
  }
  if (/^--- \/dev\/null$/m.test(diff)) {
    reasons.push('creating files is not allowed');
  }

  const files = targetPaths(diff);
  if (files.length === 0) {
    reasons.push('no +++ target path found');
  }
  for (const path of files) {
    if (path === '/dev/null') {
      reasons.push('deleting a file is not allowed');
    } else if (!isSourcePath(path)) {
      reasons.push(`path not allowed: ${path}`);
    }
  }

  const changedLines = countChangedLines(diff);
  if (changedLines > maxChangedLines) {
    reasons.push(`diff too large: ${changedLines} changed lines (max ${maxChangedLines})`);
  }

  return reasons.length === 0 ? { ok: true, files, changedLines } : { ok: false, reasons };
}

/** One-line summary for the PR body and Telegram message. */
export function summarizeDiff(diff: string): string {
  const files = targetPaths(diff);
  const added = diff
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;
  const removed = diff
    .split('\n')
    .filter((line) => line.startsWith('-') && !line.startsWith('---')).length;
  return `${files.length} file(s), +${added}/-${removed}`;
}
