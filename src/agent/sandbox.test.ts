/**
 * Tests for the verification sandbox argv (`src/agent/sandbox`, security
 * review item 1): model-written code must run with no network and no host env.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sandboxArgs, VERIFY_IMAGE } from './sandbox.ts';
import { diagnose, type DiagnoseDeps } from './diagnose.ts';

const OPTIONS = { repoRoot: '/work/ytb-index', uid: 1001, gid: 118 };

describe('sandboxArgs', () => {
  const args = sandboxArgs('test', OPTIONS);

  it('cuts the network and drops privileges', () => {
    assert.deepEqual(args.slice(0, 4), ['run', '--rm', '--network', 'none']);
    assert.ok(args.includes('--read-only'));
    assert.equal(args[args.indexOf('--cap-drop') + 1], 'ALL');
    assert.equal(args[args.indexOf('--security-opt') + 1], 'no-new-privileges');
    assert.equal(args[args.indexOf('--user') + 1], '1001:118');
  });

  it('passes only fixed, secret-free variables', () => {
    const envs = args.filter((_, index) => args[index - 1] === '--env');
    assert.deepEqual(envs, [
      'HOME=/tmp',
      'CI=true',
      'npm_config_update_notifier=false',
      'WRANGLER_SEND_METRICS=false',
    ]);
    assert.ok(!args.includes('--env-file'));
    assert.ok(!args.some((arg) => arg.startsWith('--env=') || arg === '-e'));
  });

  it('mounts only the checkout and runs the script last', () => {
    const volumes = args.filter((_, index) => args[index - 1] === '--volume');
    assert.deepEqual(volumes, ['/work/ytb-index:/work/ytb-index']);
    assert.deepEqual(args.slice(-5), [VERIFY_IMAGE, 'npm', 'run', '--silent', 'test']);
    assert.match(VERIFY_IMAGE, /@sha256:[0-9a-f]{64}$/);
  });
});

describe('diagnose — verify runs in the sandbox', () => {
  it('runs every verify step through docker, never pnpm on the host', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const deps: Partial<DiagnoseDeps> = {
      loadConfig: () => ({
        sentryToken: 's',
        sentryUrl: 'https://sentry.example',
        opencodeApiKey: 'o',
        opencodeBaseUrl: 'https://model.example',
        opencodeModel: 'm',
        ghToken: 'g',
        telegramBotToken: undefined,
        telegramChatId: undefined,
        maxDiffLines: 200,
        maxAttempts: 1,
        maxTokens: 100,
        repoRoot: '/work/ytb-index',
      }),
      loadPayload: () => ({
        issueId: '1',
        title: 't',
        level: 'error',
        shortId: 'YTB-1',
        fingerprint: 'f',
        permalink: '',
      }),
      remoteBranchExists: () => false,
      fetchIssue: async () => ({
        id: '1',
        shortId: 'YTB-1',
        title: 't',
        culprit: '',
        level: 'error',
        status: 'unresolved',
        count: '1',
        firstSeen: '',
        lastSeen: '',
        permalink: '',
        metadata: {},
      }),
      fetchLatestEvent: async () => ({
        eventId: 'e',
        title: 't',
        message: '',
        platform: 'javascript',
        tags: {},
        frames: [],
      }),
      collectContext: () => [],
      readRepoRules: () => 'rules',
      complete: async () => ({
        content: '```diff\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n```',
        promptTokens: 0,
        completionTokens: 0,
      }),
      applyDiff: () => undefined,
      hasChanges: () => true,
      resetTree: () => undefined,
      run: (command, args) => {
        calls.push({ command, args });
        return { ok: true, status: 0, output: '' };
      },
      commitAndPush: () => undefined,
      openDraftPr: () => 'https://github.example/pull/1',
      notify: async () => true,
      log: () => undefined,
      error: () => undefined,
    };

    assert.equal(await diagnose({}, deps), 0);
    assert.deepEqual(
      calls.map((call) => call.command),
      ['docker', 'docker', 'docker', 'docker'],
    );
    for (const call of calls) {
      assert.equal(call.args[call.args.indexOf('--network') + 1], 'none');
    }
  });
});
