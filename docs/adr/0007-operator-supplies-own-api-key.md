# The Operator pastes their own YouTube API key; no Google sign-in

v2 lets the Operator pay for an Ingest with their own YouTube Data API key (the OperatorKey) instead of the repository's. Pasting a key is the simplest auth that holds up: "Sign in with Google" with the `youtube.readonly` scope looks simpler but bills every call to _the app's_ Google Cloud project, not to the person signing in, so it would not give anyone their own quota. It also brings the unverified-app warning and a 100-new-user cap until Google verifies the app (which can take months), plus refresh tokens the Worker would have to keep, and none of that unlocks anything for public data. The key is checked when it is submitted. The Worker runs a local shape check, then makes one `channels.list?part=id` call (1 unit) against a fixed public channel, so the Operator learns straight away whether the key is invalid, out of quota, or belongs to a project without the YouTube Data API enabled. Until now the server had never talked to YouTube, so that one call amends ADR-0002/0003 (see their status lines).

## Status

accepted. Amends ADR-0002 and ADR-0003: the read server now makes exactly one kind of outbound YouTube call, key validation, and does it without importing `src/yt`. Amended by ADR-0011: the browser also sends the OperatorKey straight to YouTube for LiveSearch.

## Considered Options

- **Sign in with Google (`youtube.readonly`)**: rejected. Quota lands on the app's project, so it never gives anyone their own quota. Unverified apps are capped at 100 new users and show an interstitial. Refresh tokens would have to be stored and encrypted in D1. Every endpoint we use already works with a key.
- **Keep only the repository secret `YOUTUBE_API_KEY`**: rejected as the only path, because the Operator cannot rotate or swap keys without repo access. It stays as the fallback when no OperatorKey is supplied (ADR-0008).
- **Shape check only, no live probe**: what v1 did (spec v1 §8). Rejected for the web app: a well-formed but revoked key, or one with exhausted quota, would only fail minutes later on the runner. One unit per check is cheap.
- **OperatorKey pasted in the web app, probed once (chosen)**.

## Consequences

- `server/api` gets a small key-check route that calls `fetch` directly and maps the Google error envelope to one of `ok | missing | malformed | invalid | quotaExceeded | apiNotEnabled | restricted | unavailable`. It keeps its own copy of the key-shape regex, just as `server/api/channel-input.ts` keeps its own channel parser, so `server` still never imports `yt` (`src/architecture.test.ts` is unchanged).
- The check is behind the operator token, like every write: anonymous callers cannot use the Worker to probe keys or spend someone's quota.
- The browser keeps the OperatorKey next to the operator token (ADR-0005's model) and sends it only on the check and trigger calls. The Worker never stores it in plaintext (ADR-0008).
- Single Operator, unchanged: there are no accounts, so ADR-0001's 7-day user-deletion affordance stays exempt.
