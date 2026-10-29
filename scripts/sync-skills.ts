/**
 * Vendor the agent skills listed in `.claude/skills/skills.json`.
 *
 * Clones `source` at the pinned `commit` into a temp dir and replaces each
 * `.claude/skills/<name>/` with the upstream folder, plus the upstream
 * LICENSE. Committing the result keeps skills identical for every agent —
 * local, cloud sessions and CI — with no install step.
 *
 * Usage: `pnpm skills:sync` (bump `commit` first to update).
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

interface Manifest {
  source: string;
  commit: string;
  skills: Record<string, string>;
}

const SKILLS_DIR = resolve('.claude/skills');
const manifest = JSON.parse(readFileSync(join(SKILLS_DIR, 'skills.json'), 'utf8')) as Manifest;
const checkout = mkdtempSync(join(tmpdir(), 'skills-'));

try {
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: checkout, stdio: 'inherit' });
  };
  git('init', '-q');
  git('remote', 'add', 'origin', manifest.source);
  git('fetch', '-q', '--depth', '1', 'origin', manifest.commit);
  git('checkout', '-q', 'FETCH_HEAD');

  for (const [name, path] of Object.entries(manifest.skills)) {
    const from = join(checkout, path);
    if (!existsSync(join(from, 'SKILL.md'))) throw new Error(`${name}: no SKILL.md at ${path}`);
    const to = join(SKILLS_DIR, name);
    rmSync(to, { recursive: true, force: true });
    // Codex-only metadata; Claude Code and other agents read SKILL.md.
    cpSync(from, to, {
      recursive: true,
      filter: (src) => !src.includes(`${join(from, 'agents')}`),
    });
    console.log(`synced ${name}`);
  }
  cpSync(join(checkout, 'LICENSE'), join(SKILLS_DIR, 'LICENSE'));
} finally {
  rmSync(checkout, { recursive: true, force: true });
}
