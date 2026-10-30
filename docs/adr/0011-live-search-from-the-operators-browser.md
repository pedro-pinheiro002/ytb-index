# LiveSearch runs in the Operator's browser with the OperatorKey and stores nothing

On `/search`, with terms and one Channel picked, an Operator whose browser holds an OperatorKey (ADR-0007) can also ask YouTube directly: the page's script calls `commentThreads.list?allThreadsRelatedToChannelId=…&searchTerms=…` from the browser and renders the hits in place. YouTube does the filtering, so a search costs 1 unit per 100 matching threads, capped at 3 units, and finds comments the Catalog does not have yet (posted after the last Ingest, or past ADR-0001's 30 days). The key goes from the browser to Google and nowhere else; the Worker never sees it or the results, and nothing is written to the Catalog. The SearchQuery stays as ADR-0010 has it: Catalog only, for every Visitor.

## Status

accepted. Amends ADR-0007: the browser now also sends the OperatorKey to YouTube itself, for LiveSearch, besides the check and trigger calls to the Worker. Amends ADR-0010 only in wording: `/search` can show a second, separate LiveSearch section; the SearchQuery is unchanged.

## Considered Options

- **The Worker calls YouTube with a key of its own**: rejected. It puts a repository key back into the Worker, which ADR-0007/0008 moved out, and lets any Visitor spend that quota.
- **The Worker proxies the OperatorKey**: rejected. The key would reach the Worker on every search, the Worker's IP breaks IP-restricted keys, and it buys nothing over calling Google from the browser, which the API allows (CORS) and which keeps HTTP-referrer key restrictions working.
- **Replace the Catalog search with live search**: rejected. The API has no author, date or kind filter, so author search would page the whole Channel on every query (about 1 unit per 100 comments), and YouTube neither folds accents (`video` does not find `vídeo`) nor ranks.
- **Browser-side LiveSearch next to the SearchQuery, Operator only (chosen)**. Measured on a 1,049-comment Channel on 2026-10-30: 46 / 38 / 83 threads for three queries, 1 unit each.

## Consequences

- The logic lives in `src/server/live-search-script.ts` as a plain-JS string: a DOM-free core (tested against a fake `fetch`) plus the wiring. Hits are built with `textContent` only, so no markup from YouTube is parsed. `server` still never imports `yt`.
- Only Operators with a stored OperatorKey see the section (it renders `hidden`); Visitors get the SearchQuery alone, and the Worker's quota is never involved.
- `searchTerms` matches Replies too, so the page asks for `part=snippet,replies` and shows the matching Reply under its thread. YouTube returns at most 5 Replies inline; when the match is in one it did not return, the hit says so.
- Errors map to messages (out of quota, rejected key, API not enabled, restricted key, network); a Channel with comments disabled shows no hits.
