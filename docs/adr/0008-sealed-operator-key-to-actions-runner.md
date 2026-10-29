# The OperatorKey reaches the Actions runner sealed; Ingest stays on Actions

With ADR-0007 the YouTube key arrives in a browser request rather than living as a repository secret, but the Ingest still has to run on GitHub Actions (ADR-0005): moving it into the Worker would mean porting `src/yt` under the Workers CPU limits that ADR-0005 rejected. So the Worker _seals_ the OperatorKey before dispatch. It encrypts the key with RSA-OAEP-256 (WebCrypto, available in both Workers and Node 24) under a public key held as a plain Worker var, and puts only the ciphertext in the `repository_dispatch` `client_payload`. The runner decrypts it with the matching private key, which is a repository secret, and masks it in the log before the CLI reads it. The plaintext key is never written to D1, the workflow log, or the event payload, so the repository can stay public (ADR-0004).

## Status

accepted. Amends ADR-0005: `YOUTUBE_API_KEY` stops being the only ingest key and becomes the fallback used when an IngestRequest carries no OperatorKey. Execution home, status reporting and the stale-request reclaim are unchanged.

## Considered Options

- **Ingest inside the Worker (Workflows / Durable Object alarms)**: rejected again, for the same reasons as in ADR-0005 (porting `src/yt` under 10 ms CPU per step). Live-chat polling (ADR-0009) would also need a long-lived timer loop that Actions already provides for up to 6 h.
- **Send the key in plaintext in `client_payload`**: rejected. Run metadata on a public repository is widely readable, and any `echo` or debug step would leak it.
- **Store the key in D1, encrypted with a Worker secret**: rejected. The runner would then need that Worker secret too, which doubles where the secret lives, and a D1 export would carry the ciphertext. Sealing per request keeps nothing at rest.
- **Local CLI only (key in `.env`)**: kept as the dev, offline and repair path (ADR-0003), not as the web app's path.
- **Sealed per-request key to Actions (chosen)**.

## Consequences

- New config: `INGEST_SEAL_PUBLIC_KEY` (Worker var, a public JWK, safe to commit in `wrangler.jsonc`) and `INGEST_SEAL_PRIVATE_KEY` (repo secret, JWK). Generating the pair is a one-off documented step. Rotating it means replacing both.
- If an OperatorKey is supplied but the public key is not configured, the trigger fails closed (`503`). With no OperatorKey, the runner uses the `YOUTUBE_API_KEY` repo secret as before.
- The seal format (`v1.<base64url ciphertext>`) is written in `server/api` and read in `cli`. Neither may import the other, so a cross-module round-trip test pins the format.
- `ingest_requests` records where the key came from (`operator` or `repo`), never the key itself.
- RSA-OAEP-256 with a 2048-bit key encrypts up to 190 bytes, which is enough for a ~39-character API key, so no hybrid scheme is needed.
