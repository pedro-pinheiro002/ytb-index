/**
 * GitHub `repository_dispatch` client for the repair agent
 * (`server/api/github-agent-dispatch`).
 *
 * Fires `event_type: "agent-diagnose"` to wake `.github/workflows/agent-diagnose.yml`
 * with the Sentry issue coordinates in `client_payload`. Reuses the existing
 * Contents: write PAT (`GH_DISPATCH_PAT`) that the ingest API already holds —
 * the agent job only ever pushes a branch and opens a draft PR, it never
 * deploys.
 *
 * `transport` is injectable so tests never touch the network; production
 * defaults to the runtime's global `fetch`.
 */

/** The narrow fetch surface this client needs (also the test seam). */
export type AgentDispatchTransport = (url: string, init: RequestInit) => Promise<Response>;

/** The subset of a Sentry issue the workflow needs to start a run. */
export interface AgentIssuePayload {
  /** Sentry issue id (numeric, as a string). */
  issueId: string;
  /** Human title (`TypeError: x is not a function`). */
  title: string;
  /** `error` | `fatal` — enforced upstream, forwarded for the prompt. */
  level: string;
  /** Sentry short id (`YTB-INDEX-1A`), used in branch names and PR titles. */
  shortId: string;
  /** Sentry grouping fingerprint — stable across occurrences of one bug. */
  fingerprint: string;
  /** Absolute link back to the issue in the Sentry UI. */
  permalink: string;
}

/** Inputs for {@link dispatchAgentDiagnosis}. */
export interface AgentDispatchOptions {
  /** GitHub owner (`GH_OWNER`). */
  owner: string;
  /** GitHub repository name (`GH_REPO`). */
  repo: string;
  /** Fine-grained PAT with Contents: write (`GH_DISPATCH_PAT`). */
  pat: string;
  /** The issue coordinates to hand to the workflow. */
  issue: AgentIssuePayload;
  /** Injectable transport; defaults to `globalThis.fetch`. */
  transport?: AgentDispatchTransport | undefined;
}

/**
 * POST a `repository_dispatch` for one diagnosis run.
 *
 * Resolves on any 2xx/3xx from GitHub; throws on a non-OK response, a network
 * error, or missing configuration — the webhook route reports 502 and lets
 * Sentry retry.
 */
export async function dispatchAgentDiagnosis(options: AgentDispatchOptions): Promise<void> {
  const { owner, repo, pat, issue } = options;
  if (owner === '' || repo === '' || pat === '') {
    throw new Error('repository_dispatch is not configured (GH_OWNER, GH_REPO, GH_DISPATCH_PAT)');
  }

  const transport = options.transport ?? globalThis.fetch;
  const response = await transport(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/dispatches`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${pat}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        // GitHub rejects requests without a User-Agent.
        'user-agent': 'ytb-index-worker',
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify({
        event_type: 'agent-diagnose',
        client_payload: { issue },
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`repository_dispatch returned ${response.status}`);
  }
}
