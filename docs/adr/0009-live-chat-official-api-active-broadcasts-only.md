# Live chat comes from the official API only, while the Broadcast is on air

The YouTube Data API serves `liveChatMessages.list` only while a Broadcast is on air: the chat id comes from `videos.list` → `liveStreamingDetails.activeLiveChatId`, which disappears when the stream ends. The replay of a finished Broadcast's chat is available only through unofficial endpoints (innertube or page scraping), which carry Terms of Service risk and can break without notice. We capture LiveChatMessages **only from Broadcasts that are on air when an Ingest runs**, through the official API and an API key, and record nothing for Broadcasts that have already ended. Each message's offset is `publishedAt − liveStreamingDetails.actualStartTime`, floored at 0. Capture is opt-in per IngestRequest and has its own quota budget, because polling is the most expensive thing the app does: about 5 units per poll at the server-chosen `pollingIntervalMillis` (often 5–10 s) is roughly 1,800–3,600 units per hour.

## Status

accepted

## Considered Options

- **Unofficial replay source behind a flag**: rejected for now; the Operator declined it. It is the only way to get chat for finished Broadcasts. If it returns, it gets its own ADR, its own module outside `src/yt`, and a default-off flag.
- **Defer live chat entirely**: rejected. The official path is small, and a record type that already exists makes a later replay source a data-source change, not a schema change.
- **Poll from the Worker (cron or Durable Object)**: rejected for the same reason as ADR-0008. Actions already gives a 6 h job.
- **Official API, on-air Broadcasts only, opt-in and budgeted (chosen)**.

## Consequences

- LiveChatMessages are Non-Authorized Data like comments: they carry `fetched_at`, redact after 30 days through their own `_active` view, and are left out of search once expired (ADR-0001).
- Only text messages (`textMessageEvent`) and the text of Super Chats (`superChatEvent.userComment`) are stored. Membership, sticker, moderation and poll events are skipped.
- Capture ends at whichever comes first: the chat ending (`offlineAt` set, or a `liveChatEnded` / `liveChatNotFound` error), the chat budget (default 3,000 units, counted on the run's `QuotaCounter`), or a wall-clock cap below the 6 h runner limit. Messages are written in chunks as they arrive, so a run that is cut off keeps what it has.
- An Operator who wants a Broadcast's chat has to trigger an Ingest while it is live. The UI says so, and a finished Broadcast with no chat is shown as "chat not captured", not as an error.
- The newer gRPC `streamList` endpoint might lower quota per message. It is noted as a follow-up and not adopted, because it would add a gRPC dependency.
