/**
 * Repair-agent entry point (`src/agent/diagnose`), run by
 * `.github/workflows/agent-diagnose.yml`.
 *
 * Pipeline:
 *   1. Load config + the dispatched issue payload (fail fast, before spending
 *      a single token).
 *   2. Skip when the fix branch already exists — the authoritative dedup; the
 *      Worker's debounce only covers a single isolate.
 *   3. Fetch the issue and its latest event from Sentry, then read the source
 *      around the in-app frames.
 *   4. Ask OpenCode Go for a unified diff, validate it against the `src/`
 *      allowlist, apply it, and verify with `pnpm typecheck && pnpm test`.
 *      One repair round is allowed, fed with the verifier output.
 *   5. On success: push `agent/fix-<short-id>` and open a **draft** PR.
 *      On failure: notify and exit non-zero.
 *
 * The job never deploys and never merges. Deploy remains the existing
 * `push: main` path in `ci.yml`, gated by CI and by a human.
 *
 * Every side effect goes through `DiagnoseDeps`: the pipeline is testable
 * without GitHub, Sentry, a model, or a working tree.
 */
import {
  AgentConfigError,
  loadConfig,
  loadPayload,
  optionalValue,
  type AgentConfig,
  type AgentPayload,
} from './config.ts';
import { collectContext } from './context.ts';
import {
  applyDiff,
  branchName,
  commitAndPush,
  hasChanges,
  openDraftPr,
  remoteBranchExists,
  resetTree,
  run,
} from './git.ts';
import { escapeHtml, notify, type TelegramOptions } from './notify.ts';
import { complete } from './opencode.ts';
import { extractDiff, summarizeDiff, validateDiff } from './patch.ts';
import { buildMessages, buildRepairMessages, type ChatMessage, type Incident } from './prompt.ts';
import { fetchIssue, fetchLatestEvent, type SentryEvent, type SentryIssue } from './sentry.ts';

/** Outcome of the propose/verify loop. */
type Proposal = { ok: true; diff: string; verification: string } | { ok: false; reason: string };

/**
 * Every effect the pipeline needs, injectable for tests.
 *
 * Defaults are the real implementations; `diagnose` overlays whatever a caller
 * passes. Nothing here reaches the network or the filesystem on its own.
 */
export interface DiagnoseDeps {
  loadConfig: typeof loadConfig;
  loadPayload: typeof loadPayload;
  fetchIssue: typeof fetchIssue;
  fetchLatestEvent: typeof fetchLatestEvent;
  collectContext: typeof collectContext;
  complete: typeof complete;
  run: typeof run;
  remoteBranchExists: typeof remoteBranchExists;
  applyDiff: typeof applyDiff;
  resetTree: typeof resetTree;
  hasChanges: typeof hasChanges;
  commitAndPush: typeof commitAndPush;
  openDraftPr: typeof openDraftPr;
  notify: typeof notify;
  log: (message: string) => void;
  error: (message: string, cause?: unknown) => void;
}

/** Production wiring: the same functions the modules export. */
export const defaultDeps: DiagnoseDeps = {
  loadConfig,
  loadPayload,
  fetchIssue,
  fetchLatestEvent,
  collectContext,
  complete,
  run,
  remoteBranchExists,
  applyDiff,
  resetTree,
  hasChanges,
  commitAndPush,
  openDraftPr,
  notify,
  log: (message) => console.log(message),
  error: (message, cause) => console.error(message, ...(cause === undefined ? [] : [cause])),
};

/** Verification commands the repository already defines. */
const VERIFY_STEPS = ['typecheck', 'test'] as const;

/** Run the repository's own checks; output is fed back to the model on failure. */
function verify(deps: DiagnoseDeps, repoRoot: string): { ok: boolean; output: string } {
  for (const step of VERIFY_STEPS) {
    const result = deps.run('pnpm', [step], { cwd: repoRoot, timeoutMs: 900_000 });
    if (!result.ok) {
      return { ok: false, output: `pnpm ${step} failed:\n${result.output.slice(-4000)}` };
    }
  }
  return { ok: true, output: `pnpm ${VERIFY_STEPS.join(' && pnpm ')} passed` };
}

/** Propose a diff, apply it, verify it; at most `maxAttempts` rounds. */
async function proposeAndVerify(
  deps: DiagnoseDeps,
  config: AgentConfig,
  incident: Incident,
): Promise<Proposal> {
  let messages: ChatMessage[] = buildMessages(incident);
  let lastReason = 'no attempt was made';

  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    const completion = await deps.complete(messages, {
      baseUrl: config.opencodeBaseUrl,
      apiKey: config.opencodeApiKey,
      model: config.opencodeModel,
      session: `agent-${incident.issue.shortId}`,
    });
    deps.log(
      `[agent] attempt ${attempt}: ${completion.completionTokens} completion tokens (${config.opencodeModel})`,
    );

    const diff = extractDiff(completion.content);
    if (diff === undefined) {
      lastReason = 'the completion contained no fenced diff';
      messages = messages.concat({ role: 'user', content: `Output one ${'```'}diff block only.` });
      continue;
    }

    const validation = validateDiff(diff, config.maxDiffLines);
    if (!validation.ok) {
      lastReason = `patch rejected: ${validation.reasons.join('; ')}`;
      deps.log(`[agent] ${lastReason}`);
      messages = buildRepairMessages(incident, diff, lastReason);
      continue;
    }

    try {
      deps.applyDiff(config.repoRoot, diff);
    } catch (error) {
      deps.resetTree(config.repoRoot);
      lastReason = error instanceof Error ? error.message : String(error);
      deps.log(`[agent] ${lastReason}`);
      messages = buildRepairMessages(incident, diff, lastReason);
      continue;
    }

    if (!deps.hasChanges(config.repoRoot)) {
      deps.resetTree(config.repoRoot);
      lastReason = 'the patch applied but changed nothing';
      messages = buildRepairMessages(incident, diff, lastReason);
      continue;
    }

    const verification = verify(deps, config.repoRoot);
    if (verification.ok) {
      deps.log(`[agent] verified: ${summarizeDiff(diff)}`);
      return { ok: true, diff, verification: verification.output };
    }

    deps.resetTree(config.repoRoot);
    lastReason = verification.output;
    deps.log('[agent] verification failed; asking for a repair');
    messages = buildRepairMessages(incident, diff, verification.output);
  }

  return { ok: false, reason: lastReason };
}

/** Build the draft PR body, including the proposed diff for review. */
export function prBody(
  issue: SentryIssue,
  config: AgentConfig,
  diff: string,
  verification: string,
): string {
  const fence = '```';
  const truncated = diff.length > 20_000 ? `${diff.slice(0, 20_000)}\n... (truncated)` : diff;
  return [
    `Sentry issue: [${issue.shortId}](${issue.permalink})`,
    '',
    `- title: ${issue.title}`,
    `- culprit: ${issue.culprit || '(unknown)'}`,
    `- occurrences: ${issue.count}`,
    `- model: ${config.opencodeModel}`,
    `- diff: ${summarizeDiff(diff)}`,
    '',
    '## Verification',
    '',
    `\`${verification}\``,
    '',
    '<details><summary>Proposed diff</summary>',
    '',
    `${fence}diff`,
    truncated,
    fence,
    '',
    '</details>',
    '',
    '---',
    'Generated by agent-swe from a Sentry issue. Draft on purpose:',
    'review it, then merge — `ci.yml` deploys to Cloudflare only after a push to `main`.',
  ].join('\n');
}

/** Console + Telegram summary for a failed run. */
export function failureMessage(payload: AgentPayload, reason: string): string {
  return [
    `<b>agent-swe: falhou</b> ${escapeHtml(payload.shortId)}`,
    escapeHtml(payload.title),
    `<code>${escapeHtml(reason.slice(0, 600))}</code>`,
    payload.permalink,
  ].join('\n');
}

/** Run one diagnosis. Returns the process exit code. */
export async function diagnose(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<DiagnoseDeps> = {},
): Promise<number> {
  const deps: DiagnoseDeps = { ...defaultDeps, ...overrides };
  const telegram: TelegramOptions = {
    // Normalized here (not via `loadConfig`) because the config-failure path
    // notifies before a config exists; `''` from an unset secret must not look
    // like a configured bot.
    botToken: optionalValue(env.TELEGRAM_BOT_TOKEN),
    chatId: optionalValue(env.TELEGRAM_CHAT_ID),
  };

  let config: AgentConfig;
  let payload: AgentPayload;
  try {
    config = deps.loadConfig(env);
    payload = deps.loadPayload(env.AGENT_PAYLOAD);
  } catch (error) {
    const message = error instanceof AgentConfigError ? error.message : String(error);
    deps.error(`[agent] ${message}`);
    await deps.notify(
      telegram,
      `<b>agent-swe: config inválida</b>\n<code>${escapeHtml(message)}</code>`,
    );
    return 1;
  }

  const branch = branchName(payload.shortId);
  if (deps.remoteBranchExists(config.repoRoot, branch)) {
    deps.log(`[agent] ${branch} already exists — skipping ${payload.shortId}`);
    await deps.notify(
      telegram,
      `agent-swe: <code>${escapeHtml(branch)}</code> já existe; nada a fazer.`,
    );
    return 0;
  }

  try {
    const issue = await deps.fetchIssue(config.sentryUrl, config.sentryToken, payload.issueId);
    if (issue.status === 'resolved' || issue.status === 'ignored' || issue.status === 'muted') {
      deps.log(`[agent] ${issue.shortId} is ${issue.status} — skipping`);
      return 0;
    }

    const event = await deps.fetchLatestEvent(
      config.sentryUrl,
      config.sentryToken,
      payload.issueId,
    );
    const files = deps.collectContext(config.repoRoot, event.frames);
    deps.log(
      `[agent] ${issue.shortId}: ${event.frames.length} frame(s), ${files.length} file excerpt(s)`,
    );

    const proposal = await proposeAndVerify(deps, config, { issue, event, files });
    if (!proposal.ok) {
      deps.error(`[agent] giving up: ${proposal.reason.slice(0, 800)}`);
      await deps.notify(telegram, failureMessage(payload, proposal.reason));
      return 1;
    }

    const title = `fix(agent): ${issue.title}`.slice(0, 72);
    deps.commitAndPush(config.repoRoot, branch, `${title}\n\nSentry: ${issue.permalink}`);
    const url = deps.openDraftPr(config.repoRoot, {
      branch,
      title,
      body: prBody(issue, config, proposal.diff, proposal.verification),
    });

    deps.log(`[agent] draft PR: ${url}`);
    await deps.notify(
      telegram,
      [
        `<b>agent-swe: PR aberto</b> ${escapeHtml(issue.shortId)}`,
        escapeHtml(title),
        `<code>${escapeHtml(summarizeDiff(proposal.diff))}</code>`,
        url,
      ].join('\n'),
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.error('[agent] run failed', error);
    await deps.notify(telegram, failureMessage(payload, message));
    return 1;
  }
}

if (process.argv[1]?.endsWith('diagnose.ts') === true) {
  diagnose().then((code) => {
    process.exitCode = code;
  });
}
