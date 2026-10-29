/**
 * App configuration from environment variables (`server/config`).
 *
 * The Worker (bindings on `env`) and the Node server (`process.env`) read the
 * same variable names, so both build their `createApp` options here. Adding a
 * variable in one place then reaches both runtimes. The module only reads
 * the object it is given, so it stays inside the Worker import graph rules.
 */
import type { AgentHookConfig } from './api/agent-hook.ts';
import type { IngestApiConfig } from './api/ingest.ts';

/** Variables the app reads; Worker bindings and `process.env` share these names. */
export interface AppEnv {
  /** Operator bearer token for `POST /api/ingest` (secret). */
  OPERATOR_TOKEN?: string | undefined;
  /** Fine-grained GitHub PAT for `repository_dispatch` (secret). */
  GH_DISPATCH_PAT?: string | undefined;
  /** GitHub owner for `repository_dispatch` (plain var). */
  GH_OWNER?: string | undefined;
  /** GitHub repository name for `repository_dispatch` (plain var). */
  GH_REPO?: string | undefined;
  /** Sentry Internal Integration client secret (secret). */
  SENTRY_HOOK_SECRET?: string | undefined;
  /** Kill switch for the repair agent; `"false"` disables the webhook (var). */
  AGENT_ENABLED?: string | undefined;
}

/** The env-derived part of `CreateAppOptions`. */
export interface AppConfig {
  ingest: IngestApiConfig;
  agentHook: AgentHookConfig;
}

/** Build the ingest API and agent-hook config from `env`. Missing values fail closed. */
export function appConfigFromEnv(env: AppEnv): AppConfig {
  return {
    ingest: {
      operatorToken: env.OPERATOR_TOKEN,
      dispatchPat: env.GH_DISPATCH_PAT,
      ghOwner: env.GH_OWNER,
      ghRepo: env.GH_REPO,
    },
    agentHook: {
      hookSecret: env.SENTRY_HOOK_SECRET,
      dispatchPat: env.GH_DISPATCH_PAT,
      ghOwner: env.GH_OWNER,
      ghRepo: env.GH_REPO,
      enabled: env.AGENT_ENABLED !== 'false',
    },
  };
}
