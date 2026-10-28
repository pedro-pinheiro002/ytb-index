/**
 * Reads the source around a stack trace (`src/agent/context`).
 *
 * Sentry frames point at repository paths, so the agent can hand the model
 * the *actual* code instead of asking it to guess. Only files under `src/`
 * are read: anything else (workflows, scripts, lockfiles) is out of scope by
 * construction, which is the same allowlist `patch.ts` enforces on the way
 * back.
 */
import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { SentryFrame } from './sentry.ts';

/** One file excerpt handed to the model. */
export interface FileContext {
  /** Repository-relative path (`src/server/routes/video.ts`). */
  path: string;
  /** First line number of the excerpt (1-based). */
  startLine: number;
  /** The excerpt, without line-number prefixes. */
  text: string;
}

/** Hard caps: they bound prompt size and therefore cost. */
const MAX_FILES = 5;
const MAX_LINES_PER_FILE = 160;
const WINDOW_BEFORE = 40;
const WINDOW_AFTER = 60;

/** Only files under `src/` are eligible (must match `patch.ts`'s allowlist). */
export function isSourcePath(path: string): boolean {
  return /^src\/[A-Za-z0-9._/-]+\.(ts|tsx)$/.test(path) && !path.includes('..');
}

/**
 * Resolve `path` inside `repoRoot` and refuse anything that escapes it.
 *
 * String checks alone are not enough (`src/../../etc/passwd` is a valid
 * prefix match), so the resolved absolute path is compared too.
 */
export function resolveInside(repoRoot: string, path: string): string | undefined {
  if (!isSourcePath(path)) {
    return undefined;
  }
  const root = resolve(repoRoot);
  const absolute = resolve(root, path);
  if (absolute !== root && !absolute.startsWith(root + sep)) {
    return undefined;
  }
  return absolute;
}

/**
 * Collect excerpts for the innermost in-app frames.
 *
 * Frames arrive with the innermost *last* (Sentry order), so the list is
 * reversed before deduplication: the frame that actually threw wins over its
 * callers when two frames point at the same file.
 */
export function collectContext(
  repoRoot: string,
  frames: SentryFrame[],
  limits: { maxFiles?: number; maxLines?: number } = {},
): FileContext[] {
  const maxFiles = limits.maxFiles ?? MAX_FILES;
  const maxLines = limits.maxLines ?? MAX_LINES_PER_FILE;
  const seen = new Set<string>();
  const out: FileContext[] = [];

  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index];
    if (frame === undefined || !frame.inApp) {
      continue;
    }
    const path = frame.filename.replace(/^\.\//, '');
    const absolute = resolveInside(repoRoot, path);
    if (absolute === undefined || seen.has(path)) {
      continue;
    }
    seen.add(path);

    let lines: string[];
    try {
      lines = readFileSync(absolute, 'utf8').split('\n');
    } catch {
      continue;
    }

    const center = frame.lineNo ?? 1;
    const start = Math.max(1, center - WINDOW_BEFORE);
    const end = Math.min(lines.length, center + WINDOW_AFTER);
    const slice = lines.slice(start - 1, end).slice(0, maxLines);
    out.push({ path, startLine: start, text: slice.join('\n') });

    if (out.length >= maxFiles) {
      break;
    }
  }

  return out;
}
