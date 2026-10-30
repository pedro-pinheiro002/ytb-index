/**
 * Git and `gh` operations for the repair agent (`src/agent/git`).
 *
 * Every command runs through `execFile`/`spawnSync` with an argument array —
 * never a shell string — because branch names and PR titles are derived from
 * Sentry data. The runner's `GITHUB_TOKEN` gives `contents: write` and
 * `pull-requests: write`; the job has no Cloudflare credentials, so "the agent
 * went rogue" tops out at a branch nobody merged.
 */
import { spawnSync } from 'node:child_process';

/**
 * Per-command credentials for talking to `origin`. The checkout keeps none
 * (`persist-credentials: false`), so the sandboxed verify steps cannot read a
 * token from `.git/config`; `gh` hands `GH_TOKEN` to each remote command and
 * nothing is written to disk.
 */
const GH_AUTH = ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'];

/** Outcome of a subprocess: exit status plus merged stdout/stderr. */
export interface CommandResult {
  ok: boolean;
  status: number;
  output: string;
}

/** Run a command with no shell, optional stdin, bounded by a timeout. */
export function run(
  command: string,
  args: string[],
  options: { cwd: string; input?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv },
): CommandResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    input: options.input,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 120_000,
    env: options.env ?? process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return { ok: result.status === 0, status: result.status ?? -1, output };
}

/** Run git and throw with its output when it fails. */
export function git(cwd: string, args: string[], input?: string): string {
  const result = run('git', args, { cwd, ...(input === undefined ? {} : { input }) });
  if (!result.ok) {
    throw new Error(
      `git ${args.join(' ')} failed (${result.status}): ${result.output.slice(0, 800)}`,
    );
  }
  return result.output;
}

/** Turn a Sentry short id into a branch-safe slug (`YTB-INDEX-1A` -> `ytb-index-1a`). */
export function branchName(shortId: string): string {
  const slug = shortId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `agent/fix-${slug === '' ? 'issue' : slug}`;
}

/** True when the remote already has this branch (the authoritative dedup). */
export function remoteBranchExists(cwd: string, branch: string): boolean {
  const result = run(
    'git',
    [...GH_AUTH, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`],
    { cwd },
  );
  return result.ok && result.output.trim() !== '';
}

/** Check-then-apply a unified diff; throws without touching the tree on failure. */
export function applyDiff(cwd: string, diff: string): void {
  const check = run('git', ['apply', '--check', '--whitespace=nowarn', '-'], { cwd, input: diff });
  if (!check.ok) {
    throw new Error(`git apply --check rejected the patch: ${check.output.slice(0, 600)}`);
  }
  git(cwd, ['apply', '--whitespace=nowarn', '-'], diff);
}

/** Discard every unstaged change (only tracked files were ever touched). */
export function resetTree(cwd: string): void {
  run('git', ['checkout', '--', '.'], { cwd });
}

/** True when the patch actually changed something. */
export function hasChanges(cwd: string): boolean {
  return !run('git', ['diff', '--quiet'], { cwd }).ok;
}

/** Create the branch, commit `src/` only, and push it. */
export function commitAndPush(cwd: string, branch: string, message: string): void {
  git(cwd, ['config', 'user.name', 'agent-swe']);
  git(cwd, ['config', 'user.email', 'agent-swe@users.noreply.github.com']);
  git(cwd, ['switch', '-c', branch]);
  git(cwd, ['add', '--', 'src']);
  git(cwd, ['commit', '-m', message]);
  git(cwd, [...GH_AUTH, 'push', '--set-upstream', 'origin', branch]);
}

/** Open a draft PR and return its URL (the last line `gh` prints). */
export function openDraftPr(
  cwd: string,
  options: { branch: string; title: string; body: string },
): string {
  const result = run(
    'gh',
    [
      'pr',
      'create',
      '--draft',
      '--base',
      'main',
      '--head',
      options.branch,
      '--title',
      options.title,
      '--body',
      options.body,
    ],
    { cwd, timeoutMs: 60_000 },
  );
  if (!result.ok) {
    throw new Error(`gh pr create failed (${result.status}): ${result.output.slice(0, 600)}`);
  }
  const lines = result.output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return lines.at(-1) ?? '';
}
