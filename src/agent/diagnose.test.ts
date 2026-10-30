/**
 * Tests for the diagnosis pipeline (`src/agent/diagnose`) via its seams.
 *
 * Everything the run touches — Sentry, the model, git, the verifier, Telegram —
 * arrives through `DiagnoseDeps`, so these cover the decisions that cost money
 * or open PRs: fail fast on bad config, skip before calling the model, retry
 * once with the verifier output, and refuse a patch that leaves `src/`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentConfig, AgentPayload } from './config.ts';
import { AgentConfigError } from './config.ts';
import { readFileSync } from 'node:fs';
import { diagnose, failureMessage, prBody, VERIFY_STEPS, type DiagnoseDeps } from './diagnose.ts';
import type { TelegramOptions } from './notify.ts';
import type { SentryEvent, SentryIssue } from './sentry.ts';

/** A diff the allowlist accepts: one changed line in `src/`. */
function goodDiff(path = 'src/worker.ts'): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,3 +1,3 @@',
    ' const a = 1;',
    '-const b = 2;',
    '+const b = 3;',
    ' const c = 4;',
    '',
  ].join('\n');
}

/** A diff the allowlist must reject: deployment config is out of bounds. */
function forbiddenDiff(): string {
  return [
    'diff --git a/package.json b/package.json',
    '--- a/package.json',
    '+++ b/package.json',
    '@@ -1,2 +1,2 @@',
    '-{ "name": "ytb-index" }',
    '+{ "name": "owned" }',
    '',
  ].join('\n');
}

const CONFIG: AgentConfig = {
  sentryToken: 'sentry-token',
  sentryUrl: 'https://sentry.example',
  claudeOauthToken: 'sk-ant-oat-test',
  model: 'claude-haiku-5-5',
  ghToken: 'ghp_test',
  telegramBotToken: 'bot-token',
  telegramChatId: '42',
  maxDiffLines: 200,
  maxAttempts: 2,
  maxTokens: 8000,
  repoRoot: '/repo',
};

const PAYLOAD: AgentPayload = {
  issueId: '123',
  title: 'TypeError: loadVideo is not a function',
  level: 'error',
  shortId: 'YTB-INDEX-1A',
  fingerprint: 'abc',
  permalink: 'https://sentry.example/issues/123',
};

const ISSUE: SentryIssue = {
  id: '123',
  shortId: 'YTB-INDEX-1A',
  title: 'TypeError: loadVideo is not a function',
  culprit: 'src/worker.ts',
  count: '7',
  status: 'unresolved',
  level: 'error',
  permalink: 'https://sentry.example/issues/123',
  metadata: { type: 'TypeError', value: 'loadVideo is not a function' },
  firstSeen: '2026-10-01T00:00:00Z',
  lastSeen: '2026-10-02T00:00:00Z',
};

const EVENT: SentryEvent = {
  eventId: 'event-1',
  title: 'TypeError: loadVideo is not a function',
  message: 'loadVideo is not a function',
  platform: 'javascript',
  tags: {},
  frames: [
    {
      filename: 'src/worker.ts',
      fn: 'fetch',
      lineNo: 12,
      colNo: undefined,
      inApp: true,
      contextLine: undefined,
    },
  ],
};

/** Recording harness: every seam is a spy, nothing touches the network or disk. */
function harness(overrides: Partial<DiagnoseDeps> = {}) {
  const state = {
    notifications: [] as string[],
    commits: [] as { branch: string; message: string }[],
    prs: [] as { branch: string; title: string; body: string }[],
    applied: [] as string[],
    resets: 0,
    completions: 0,
  };

  const deps: DiagnoseDeps = {
    loadConfig: () => CONFIG,
    loadPayload: () => PAYLOAD,
    fetchIssue: async () => ISSUE,
    fetchLatestEvent: async () => EVENT,
    collectContext: () => [],
    readRepoRules: () => '- rule',
    complete: async () => {
      state.completions += 1;
      return {
        content: `\`\`\`diff\n${goodDiff()}\`\`\``,
        promptTokens: 100,
        completionTokens: 10,
      };
    },
    run: () => ({ ok: true, status: 0, output: '' }),
    remoteBranchExists: () => false,
    applyDiff: (_cwd, diff) => {
      state.applied.push(diff);
    },
    resetTree: () => {
      state.resets += 1;
    },
    hasChanges: () => true,
    commitAndPush: (_cwd, branch, message) => {
      state.commits.push({ branch, message });
    },
    openDraftPr: (_cwd, options) => {
      state.prs.push(options);
      return 'https://github.com/pedro-pinheiro002/ytb-index/pull/99';
    },
    notify: async (_options, html) => {
      state.notifications.push(html);
      return true;
    },
    log: () => {},
    error: () => {},
    ...overrides,
  };

  return { deps, state };
}

describe('diagnose — fail fast', () => {
  it('returns 1 without calling the model when config is invalid', async () => {
    const { deps, state } = harness({
      loadConfig: () => {
        throw new AgentConfigError(['SENTRY_AUTH_TOKEN is missing']);
      },
    });

    assert.equal(await diagnose({}, deps), 1);
    assert.equal(state.completions, 0);
    assert.match(state.notifications[0] ?? '', /config inválida/);
  });

  it('returns 1 without calling the model when the payload is invalid', async () => {
    const { deps, state } = harness({
      loadPayload: () => {
        throw new Error('AGENT_PAYLOAD is not valid JSON');
      },
    });

    assert.equal(await diagnose({}, deps), 1);
    assert.equal(state.completions, 0);
    assert.match(state.notifications[0] ?? '', /config inválida/);
  });
});

describe('diagnose — skips before spending a token', () => {
  it('skips when the fix branch already exists', async () => {
    const { deps, state } = harness({ remoteBranchExists: () => true });

    assert.equal(await diagnose({}, deps), 0);
    assert.equal(state.completions, 0);
    assert.deepEqual(state.commits, []);
    assert.match(state.notifications[0] ?? '', /já existe/);
  });

  it('skips an issue a human already resolved', async () => {
    const { deps, state } = harness({ fetchIssue: async () => ({ ...ISSUE, status: 'resolved' }) });

    assert.equal(await diagnose({}, deps), 0);
    assert.equal(state.completions, 0);
    assert.deepEqual(state.prs, []);
    assert.deepEqual(state.notifications, []);
  });

  it('skips a muted issue', async () => {
    const { deps } = harness({ fetchIssue: async () => ({ ...ISSUE, status: 'muted' }) });
    assert.equal(await diagnose({}, deps), 0);
  });
});

describe('diagnose — propose and verify', () => {
  it('opens a draft PR and notifies when the patch verifies', async () => {
    const { deps, state } = harness();

    assert.equal(await diagnose({}, deps), 0);

    assert.equal(state.completions, 1);
    assert.equal(state.commits.length, 1);
    assert.equal(state.commits[0]?.branch, 'agent/fix-ytb-index-1a');
    assert.match(state.commits[0]?.message ?? '', /Sentry: https:\/\/sentry\.example\/issues\/123/);

    assert.equal(state.prs.length, 1);
    assert.equal(state.prs[0]?.branch, 'agent/fix-ytb-index-1a');
    assert.match(state.prs[0]?.title ?? '', /^fix\(agent\): TypeError/);
    assert.match(state.prs[0]?.body ?? '', /Proposed diff/);

    assert.match(state.notifications.at(-1) ?? '', /PR aberto/);
    assert.match(state.notifications.at(-1) ?? '', /pull\/99/);
  });

  it('retries once with the verifier output and then succeeds', async () => {
    let typecheckCalls = 0;
    const { deps, state } = harness({
      run: (command, args) => {
        if (args[0] === 'typecheck') {
          typecheckCalls += 1;
          if (typecheckCalls === 1) {
            return { ok: false, status: 2, output: "error TS2304: Cannot find name 'b'" };
          }
        }
        return { ok: true, status: 0, output: '' };
      },
    });

    assert.equal(await diagnose({}, deps), 0);
    assert.equal(typecheckCalls, 2);
    assert.equal(state.completions, 2);
    assert.equal(state.resets, 1);
    assert.equal(state.prs.length, 1);
  });

  it('does not call the model a third time when both attempts fail', async () => {
    const { deps, state } = harness({
      run: () => ({ ok: false, status: 1, output: 'tests failed' }),
    });

    assert.equal(await diagnose({}, deps), 1);
    assert.equal(state.completions, 2);
    assert.deepEqual(state.commits, []);
    assert.deepEqual(state.prs, []);
    assert.match(state.notifications.at(-1) ?? '', /falhou/);
  });

  it('rejects a patch outside src/ and accepts the repair', async () => {
    let attempt = 0;
    const { deps, state } = harness({
      complete: async () => {
        attempt += 1;
        return {
          content: `\`\`\`diff\n${attempt === 1 ? forbiddenDiff() : goodDiff()}\`\`\``,
          promptTokens: 100,
          completionTokens: 10,
        };
      },
    });

    assert.equal(await diagnose({}, deps), 0);
    assert.equal(attempt, 2);
    // The forbidden diff never reached the working tree.
    assert.equal(state.applied.length, 1);
    assert.equal(state.applied[0], goodDiff());
  });

  it('reprompts when the completion has no fenced diff', async () => {
    let attempt = 0;
    const { deps, state } = harness({
      complete: async () => {
        attempt += 1;
        return {
          content: attempt === 1 ? 'I cannot fix this.' : `\`\`\`diff\n${goodDiff()}\`\`\``,
          promptTokens: 100,
          completionTokens: 5,
        };
      },
    });

    assert.equal(await diagnose({}, deps), 0);
    assert.equal(attempt, 2);
    assert.equal(state.prs.length, 1);
  });

  it('resets the tree when the patch applies but changes nothing', async () => {
    const { deps, state } = harness({ hasChanges: () => false });

    assert.equal(await diagnose({}, deps), 1);
    assert.ok(state.resets >= 1);
    assert.deepEqual(state.commits, []);
  });

  it('resets the tree when git apply rejects the patch', async () => {
    const { deps, state } = harness({
      applyDiff: () => {
        throw new Error('error: patch does not apply');
      },
    });

    assert.equal(await diagnose({}, deps), 1);
    assert.ok(state.resets >= 1);
    assert.deepEqual(state.prs, []);
  });
});

describe('diagnose — transport failures', () => {
  it('notifies and returns 1 when Sentry is unreachable', async () => {
    const { deps, state } = harness({
      fetchIssue: async () => {
        throw new Error('Sentry responded 502');
      },
    });

    assert.equal(await diagnose({}, deps), 1);
    assert.equal(state.completions, 0);
    assert.match(state.notifications.at(-1) ?? '', /Sentry responded 502/);
  });

  it('notifies and returns 1 when the push fails', async () => {
    const { deps, state } = harness({
      commitAndPush: () => {
        throw new Error('remote rejected the push');
      },
    });

    assert.equal(await diagnose({}, deps), 1);
    assert.deepEqual(state.prs, []);
    assert.match(state.notifications.at(-1) ?? '', /remote rejected the push/);
  });
});

describe('prBody', () => {
  it('links the issue and shows the diff for review', () => {
    const body = prBody(ISSUE, CONFIG, goodDiff(), 'pnpm typecheck && pnpm test passed');
    assert.match(body, /\[YTB-INDEX-1A\]\(https:\/\/sentry\.example\/issues\/123\)/);
    assert.match(body, /pnpm typecheck && pnpm test passed/);
    assert.match(body, /```diff/);
  });

  it('truncates a diff that would make the body unwieldy', () => {
    const huge = goodDiff().repeat(2000);
    const body = prBody(ISSUE, CONFIG, huge, 'ok');
    assert.match(body, /\.\.\. \(truncated\)/);
    assert.ok(body.length < huge.length);
  });
});

describe('failureMessage', () => {
  it('escapes HTML coming from the payload', () => {
    const message = failureMessage({ ...PAYLOAD, title: '<script>alert(1)</script>' }, 'boom <b>');
    assert.equal(message.includes('<script>'), false);
    assert.match(message, /&lt;script&gt;/);
    assert.match(message, /boom &lt;b&gt;/);
  });
});

describe('diagnose — notification settings', () => {
  it('treats blank Telegram settings as unset instead of calling the API', async () => {
    let seen: TelegramOptions | undefined;
    const { deps } = harness({
      loadConfig: () => {
        throw new AgentConfigError(['CLAUDE_CODE_OAUTH_TOKEN is missing']);
      },
      notify: async (options) => {
        seen = options;
        return true;
      },
    });

    // Actions substitutes an unset secret with '' — that must not look like a
    // configured bot, or every failure would hit `api.telegram.org/bot/sendMessage`.
    const code = await diagnose(
      { CLAUDE_CODE_OAUTH_TOKEN: '', TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '' },
      deps,
    );

    assert.equal(code, 1);
    assert.equal(seen?.botToken, undefined);
    assert.equal(seen?.chatId, undefined);
  });
});

describe('diagnose — model transport failures', () => {
  it('spends the next attempt instead of aborting the issue', async () => {
    let calls = 0;
    const { deps, state } = harness({
      complete: async () => {
        calls += 1;
        if (calls === 1) {
          // What a reasoning model returns when it thinks through the whole
          // `max_tokens` budget: HTTP 200 with an empty `content`.
          throw new Error('claude returned an empty completion (subtype=success)');
        }
        return { content: `\`\`\`diff\n${goodDiff()}\`\`\``, promptTokens: 1, completionTokens: 1 };
      },
    });

    assert.equal(await diagnose({}, deps), 0);
    assert.equal(calls, 2);
    assert.equal(state.prs.length, 1);
  });

  it('gives up cleanly when every attempt fails in transport', async () => {
    const { deps, state } = harness({
      complete: async () => {
        throw new Error('claude exited 1: rate limited');
      },
    });

    assert.equal(await diagnose({}, deps), 1);
    assert.equal(state.prs.length, 0);
    assert.match(state.notifications.at(-1) ?? '', /rate limited/);
  });
});

describe('VERIFY_STEPS', () => {
  it('matches `pnpm check`, so the agent verifies what CI verifies', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as {
      scripts: Record<string, string>;
    };
    assert.equal(pkg.scripts.check, VERIFY_STEPS.map((step) => `pnpm ${step}`).join(' && '));
  });
});
