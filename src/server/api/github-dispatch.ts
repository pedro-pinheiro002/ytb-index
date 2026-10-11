/**
 * GitHub `repository_dispatch` client (`server/api/github-dispatch`).
 *
 * Fires the one event that wakes the ingest workflow on GitHub Actions
 * (ADR-0005): `event_type: "ingest"` with the IngestRequest id and the raw
 * channel input in `client_payload`. The PAT is a Worker secret scoped to
 * Contents: write on this one repo; the owner/repo coordinates are plain
 * `vars` (public info).
 *
 * `transport` is injectable so tests never touch the network; production
 * defaults to the runtime's global `fetch`.
 */

/** The narrow fetch surface this client needs (also the test seam). */
export type DispatchTransport = (url: string, init: RequestInit) => Promise<Response>;

/** Inputs for {@link dispatchIngest}. */
export interface DispatchIngestOptions {
  /** GitHub owner (`GH_OWNER`). */
  owner: string;
  /** GitHub repository name (`GH_REPO`). */
  repo: string;
  /** Fine-grained PAT with Contents: write (`GH_DISPATCH_PAT`). */
  pat: string;
  /** The IngestRequest id to hand to the workflow. */
  requestId: string;
  /** The raw operator channel input, verbatim. */
  channel: string;
  /** Injectable transport; defaults to `globalThis.fetch`. */
  transport?: DispatchTransport | undefined;
}

/**
 * POST a `repository_dispatch` for one ingest run.
 *
 * Resolves on any 2xx/3xx from GitHub; throws on a non-OK response, a network
 * error, or missing configuration — callers mark the IngestRequest `failed`.
 */
export async function dispatchIngest(options: DispatchIngestOptions): Promise<void> {
  const { owner, repo, pat, requestId, channel } = options;
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
        event_type: 'ingest',
        client_payload: { requestId, channel },
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`repository_dispatch returned ${response.status}`);
  }
}
