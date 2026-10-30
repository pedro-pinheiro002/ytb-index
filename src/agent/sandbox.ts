/**
 * Verification sandbox for the repair agent (`src/agent/sandbox`).
 *
 * The verify steps execute model-written code (`pnpm test` runs every
 * `src/**\/*.test.ts`), and the model's input is Sentry event data that anyone
 * holding the public DSN can write. So a verify step must not reach the job's
 * secrets: not through its own env, not through `/proc/<ppid>/environ` of the
 * agent process, and not over the network. Each step therefore runs in a
 * throwaway container with no network, no inherited env, no capabilities and
 * a read-only root, seeing only the checkout (security review, item 1).
 *
 * The steps run through `npm run`: the image ships npm but not pnpm, and the
 * scripts only call binaries from the bind-mounted `node_modules/.bin`.
 */

/**
 * Node image the steps run in, pinned by digest. The tag follows `.nvmrc`;
 * trixie's glibc is new enough for the runner-built `better-sqlite3`.
 */
export const VERIFY_IMAGE =
  'node:24-trixie-slim@sha256:54f84b4cf8432b21aaffd5d3ce8d41e12cea0d10d33c09d2f3c9879d49d6b446';

/** Options for {@link sandboxArgs}. */
export interface SandboxOptions {
  /** Absolute checkout path, mounted read-write at the same path. */
  repoRoot: string;
  /** Host uid/gid the step runs as, so files it writes stay the runner's. */
  uid: number;
  gid: number;
  /** Image override for tests; defaults to {@link VERIFY_IMAGE}. */
  image?: string | undefined;
}

/**
 * The `docker` argv that runs one `package.json` script in the sandbox. The
 * script name is always the last element.
 */
export function sandboxArgs(step: string, options: SandboxOptions): string[] {
  return [
    'run',
    '--rm',
    '--network',
    'none',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--read-only',
    '--tmpfs',
    '/tmp',
    '--user',
    `${options.uid}:${options.gid}`,
    // Only these variables exist inside: `docker run` never forwards the
    // host env unless asked to.
    '--env',
    'HOME=/tmp',
    '--env',
    'CI=true',
    '--env',
    'npm_config_update_notifier=false',
    '--env',
    'WRANGLER_SEND_METRICS=false',
    '--volume',
    `${options.repoRoot}:${options.repoRoot}`,
    '--workdir',
    options.repoRoot,
    options.image ?? VERIFY_IMAGE,
    'npm',
    'run',
    '--silent',
    step,
  ];
}
