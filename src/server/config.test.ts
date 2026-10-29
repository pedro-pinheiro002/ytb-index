/**
 * Tests for env-derived app configuration (`server/config`).
 *
 * Both runtimes go through `appConfigFromEnv`, so these pin the mapping from
 * variable names to route config, including the agent kill switch.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appConfigFromEnv } from './config.ts';

describe('appConfigFromEnv', () => {
  it('maps every variable to the routes that use it', () => {
    const config = appConfigFromEnv({
      OPERATOR_TOKEN: 'op',
      GH_DISPATCH_PAT: 'pat',
      GH_OWNER: 'owner',
      GH_REPO: 'repo',
      SENTRY_HOOK_SECRET: 'hook',
    });
    assert.deepEqual(config.ingest, {
      operatorToken: 'op',
      dispatchPat: 'pat',
      ghOwner: 'owner',
      ghRepo: 'repo',
    });
    assert.deepEqual(config.agentHook, {
      hookSecret: 'hook',
      dispatchPat: 'pat',
      ghOwner: 'owner',
      ghRepo: 'repo',
      enabled: true,
    });
  });

  it('disables the agent hook only for AGENT_ENABLED="false"', () => {
    assert.equal(appConfigFromEnv({ AGENT_ENABLED: 'false' }).agentHook.enabled, false);
    assert.equal(appConfigFromEnv({ AGENT_ENABLED: 'true' }).agentHook.enabled, true);
    assert.equal(appConfigFromEnv({}).agentHook.enabled, true);
  });

  it('leaves missing secrets undefined so the routes fail closed', () => {
    const config = appConfigFromEnv({});
    assert.equal(config.ingest.operatorToken, undefined);
    assert.equal(config.agentHook.hookSecret, undefined);
  });
});
