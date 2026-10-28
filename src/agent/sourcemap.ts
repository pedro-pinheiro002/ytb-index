/**
 * Source-map resolution (`src/agent/sourcemap`).
 *
 * Cloudflare bundles the Worker into a single `worker.js`, and that is what
 * Sentry sees: every frame says `/worker.js:17698`. Reading `src/` from those
 * line numbers is impossible, so without this step the model gets no code at
 * all and invents hunks that `git apply` rejects (see ADR-0006).
 *
 * The job already has the repository, so it can rebuild the same bundle with
 * `wrangler deploy --dry-run --outdir` — which emits `worker.js.map` — and map
 * every frame back to `src/**`. The mapping is best-effort and never throws:
 * if the build or the map is unavailable, the original frames are returned and
 * the run proceeds with less context.
 */
import { readFileSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { originalPositionFor, TraceMap } from '@jridgewell/trace-mapping';
import type { SentryFrame } from './sentry.ts';
import { isSourcePath } from './context.ts';
import { run } from './git.ts';

/** Directory (relative to the repo) where the throwaway bundle is written. */
export const BUNDLE_DIR = '.agent-bundle';

/** The single file Cloudflare builds the Worker into. */
const BUNDLE_FILE = 'worker.js';

/** True when the frame points at the bundled output instead of the source. */
export function isBundledFrame(frame: SentryFrame): boolean {
  return /(^|\/)worker\.js$/.test(frame.filename);
}

/**
 * Rebuild the Worker locally and return its source map, or `null` when the
 * build fails or emits no map. Never throws.
 */
export function buildSourceMap(
  repoRoot: string,
  log: (message: string) => void = () => {},
): TraceMap | null {
  const outdir = join(repoRoot, BUNDLE_DIR);
  const result = run('pnpm', ['exec', 'wrangler', 'deploy', '--dry-run', '--outdir', outdir], {
    cwd: repoRoot,
    timeoutMs: 180_000,
  });
  if (!result.ok) {
    log(`[agent] source map: wrangler exited ${result.status}: ${result.output.slice(0, 300)}`);
    return null;
  }
  try {
    const raw = readFileSync(join(outdir, `${BUNDLE_FILE}.map`), 'utf8');
    return new TraceMap(JSON.parse(raw) as ConstructorParameters<typeof TraceMap>[0]);
  } catch (error) {
    log(`[agent] source map: ${(error as Error).message.slice(0, 300)}`);
    return null;
  }
}

/** Turn a map source (absolute or relative to the repo) into `src/...`, or `undefined`. */
function toRepoPath(repoRoot: string, source: string): string | undefined {
  const absolute = isAbsolute(source) ? source : join(repoRoot, source);
  const path = relative(repoRoot, absolute).split('\\').join('/');
  return isSourcePath(path) ? path : undefined;
}

/** Injectable seam so tests can supply a map without running a build. */
export interface ResolveOptions {
  loadMap?: (repoRoot: string) => TraceMap | null;
  log?: (message: string) => void;
}

/**
 * Replace bundled frames with the source frames they came from.
 *
 * Frames that map into `node_modules` (the SDK's own call sites) or outside
 * the repository are dropped: they are not the bug. If nothing maps, the
 * input is returned unchanged so the caller still has a stack to report.
 */
export function resolveFrames(
  repoRoot: string,
  frames: SentryFrame[],
  options: ResolveOptions = {},
): SentryFrame[] {
  if (!frames.some(isBundledFrame)) {
    return frames;
  }
  const log = options.log ?? (() => {});
  const map = options.loadMap ? options.loadMap(repoRoot) : buildSourceMap(repoRoot, log);
  if (map === null) {
    log('[agent] source map: unavailable, keeping bundled frames');
    return frames;
  }

  const resolved: SentryFrame[] = [];
  for (const frame of frames) {
    if (!isBundledFrame(frame)) {
      resolved.push(frame);
      continue;
    }
    if (frame.lineNo === undefined) {
      continue;
    }
    const position = originalPositionFor(map, {
      line: frame.lineNo,
      column: frame.colNo ?? 0,
    });
    if (position.source === null || position.line === null) {
      continue;
    }
    const source = toRepoPath(repoRoot, position.source);
    if (source === undefined) {
      continue;
    }
    resolved.push({
      ...frame,
      filename: source,
      lineNo: position.line,
      colNo: position.column ?? undefined,
      // The bundled line is meaningless once the frame points at the source.
      contextLine: undefined,
    });
  }

  return resolved.length > 0 ? resolved : frames;
}
