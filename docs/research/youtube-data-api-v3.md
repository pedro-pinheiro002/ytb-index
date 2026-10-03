# YouTube Data API v3 — facts for the v1 spec

Research note for [issue #9](https://github.com/pedro-pinheiro002/ytb-index/issues/9) (Part of #1).
Researched 2026-10-01 against Google's official documentation only (primary sources). Every claim cites its source URL; nothing here is from blog posts or third-party write-ups. Where a behavior could not be verified from a primary source it is flagged under [Uncertain claims](#uncertain-claims--follow-ups).

Quick index:
- [TL;DR for the ticket resolver](#tldr-for-the-ticket-resolver)
- [1. Listing a channel's uploads](#1-listing-a-channels-uploads)
- [2. Comments: `commentThreads.list` and `comments.list`](#2-comments-commentthreadslist-and-commentslist)
- [3. Quota](#3-quota)
- [4. Auth: API key vs OAuth 2.0](#4-auth-api-key-vs-oauth-20)
- [5. `part=` parameters needed](#5-part-parameters-needed)
- [6. Comment filtering (server-side vs client-side)](#6-comment-filtering-server-side-vs-client-side)
- [7. Gotchas](#7-gotchas)
- [8. ToS / Developer Policies on storing comment text](#8-tos--developer-policies-on-storing-comment-text)
- [Sources](#sources)
- [Uncertain claims & follow-ups](#uncertain-claims--follow-ups)

## TL;DR for the ticket resolver

- **Uploads**: resolve the channel's uploads playlist ID via `channels.list` (`part=contentDetails` → `contentDetails.relatedPlaylists.uploads`), then page through it with `playlistItems.list` (`part=snippet`, `maxResults=50`, `pageToken`). This is Google's own recommended pattern and avoids the `search.list` quota bucket (100 calls/day) and its 500-result cap for `channelId`+`type=video` searches. All three list endpoints cost **1 quota unit per call**; `search.list` additionally sits in its own 100-calls/day bucket.
- **Comments**: top-level comments via `commentThreads.list` (`part=snippet,replies`, `videoId=…`, `maxResults` 1–100, default 20, `pageToken`). `order=time` (default) or `order=relevance`. Replies are nested in `replies.comments[]` but only as a **subset**; to fetch all replies call `comments.list` with `parentId`. Both cost 1 unit/call.
- **Quota**: default **10,000 units/day** shared across all endpoints, plus dedicated 100-calls/day buckets for `search.list` and `videos.insert`. Each additional page of results costs the same again. Exceeding quota → **HTTP 403, reason `quotaExceeded`** (documented Core API error). Daily quota resets at midnight Pacific Time.
- **Auth**: read-only **public** data needs only an **API key** (`key` query param). OAuth 2.0 is required for anything private (e.g. `mine=true`, `moderationStatus=heldForReview`), and service accounts are **not** supported.
- **Comment filtering**: `commentThreads.list` has a **server-side keyword filter** (`searchTerms`), but it's a keyword match, not a full query language; anything more (by author, date range, regex, etc.) must be filtered client-side after fetching.
- **Storage of comments**: public comments are "Non-Authorized Data" under the Developer Policies and may be stored temporarily **no longer than 30 calendar days**; after that you must delete or refresh. Plan the v1 schema/refresh job accordingly.

---

## 1. Listing a channel's uploads

### Recommended: `channels.list` + `playlistItems.list` on the uploads playlist

**Step 1 — find the uploads playlist ID** ([Implementation: Videos](https://developers.google.com/youtube/v3/guides/implementation/videos)):
Call `channels.list` with `part=contentDetails`. The response property `contentDetails.relatedPlaylists.uploads` contains the playlist ID of the channel's uploaded-videos playlist. The channel can be identified by `id`, `forHandle` (`@handle`), or `forUsername` — all work with an API key (only `mine=true` requires OAuth).

**Step 2 — page through the uploads**:
Call `playlistItems.list` with `playlistId` set to the ID from step 1. `part=snippet` returns each upload's title, description, thumbnails, `publishedAt`, and — critically — the video ID at `snippet.resourceId.videoId`. Paginate with `pageToken` (`nextPageToken`/`prevPageToken` in the response). `maxResults` accepts 0–50, default 5 ([playlistItems.list](https://developers.google.com/youtube/v3/docs/playlistItems/list)).

The [API reference overview](https://developers.google.com/youtube/v3/docs) states the same pattern: "YouTube also uses a playlist to identify a channel's list of uploaded videos … You can retrieve the playlist ID for that list from the channel resource for a given channel. You can then use the `playlistItems.list` method to retrieve the list." The official `playlistItems.list` docs page embeds first-party Go / .NET / Ruby samples implementing exactly this two-step flow ([playlistItems.list — Examples](https://developers.google.com/youtube/v3/docs/playlistItems/list)).

### `search.list` — works, but Google explicitly advises against it for this job

`search.list` can return a channel's videos (`channelId` + `type=video`), but the official docs say, under the `order` parameter:

> "Because this relies on the search index, you may experience indexing delays for new content or receive incomplete result sets. **To reliably retrieve a channel's most recently uploaded videos, do not use `search.list`. Instead, use the `playlistItems.list` method to fetch the channel's uploads playlist.**"

([search.list — `order` parameter](https://developers.google.com/youtube/v3/docs/search/list#order))

Additional search.list constraints:
- `part=snippet` only ([search.list](https://developers.google.com/youtube/v3/docs/search/list)).
- When `channelId` is set and `type=video`, results are **capped at 500 videos** unless `forContentOwner`/`forDeveloper`/`forMine` is set ([search.list — `channelId`](https://developers.google.com/youtube/v3/docs/search/list#channelId)).
- `search.list` sits in its own quota bucket (100 calls/day default) — see [§3](#3-quota).

### `channels.list` — does not list videos

`channels.list` returns channel resources, not videos. It is only the first step above (resolving the uploads playlist ID); it cannot be used to enumerate a channel's videos.

### Quota cost comparison (per call)

| Endpoint | Quota cost | Notes |
|---|---|---|
| `channels.list` | **1 unit** | (Quota Calculator) |
| `playlistItems.list` | **1 unit** | (Quota Calculator) |
| `search.list` | **1 unit**, but in its own **"Search Queries" bucket limited to 100 calls/day** | (Quota Calculator; search.list reference) |
| `videos.list` (metadata enrichment) | **1 unit** | (Quota Calculator) |
| `commentThreads.list` / `comments.list` | **1 unit** each | (Quota Calculator) |

Every **additional page** of a paged result set costs the same again ([Quota Calculator](https://developers.google.com/youtube/v3/determine_quota_cost)).

**Practical v1 math** (per channel, worst case, 10,000-unit/day budget): `channels.list` (1) + `ceil(uploads/50)` × `playlistItems.list` (1 each) + optional `videos.list` enrichment in batches of up to 50 IDs (1 each). A 1,000-video channel is ≈ 1 + 20 + 20 = 41 units to index fully.

---

## 2. Comments: `commentThreads.list` and `comments.list`

### `commentThreads.list` — top-level comments

- **HTTP request**: `GET https://www.googleapis.com/youtube/v3/commentThreads` ([reference](https://developers.google.com/youtube/v3/docs/commentThreads/list)).
- **Quota cost**: 1 unit ([reference — Quota impact](https://developers.google.com/youtube/v3/docs/commentThreads/list)).
- **`part`** (required): `id`, `replies`, `snippet`. `part=snippet` yields the top-level comment; `part=snippet,replies` additionally yields nested replies.
- **Filters** (exactly one): `videoId`, `id`, or `allThreadsRelatedToChannelId`.
- **Pagination**: `pageToken` (response `nextPageToken`); `maxResults` accepts **1–100, default 20** — this is the page-size cap; the discovery document confirms `default: "20"`, `maximum: "100"`, `minimum: "1"` ([Discovery document](https://www.googleapis.com/discovery/v1/apis/youtube/v3/rest)).
- **Sort order**: `order=time` (default) or `order=relevance` (discovery document confirms default `time`).
- **`textFormat`**: `html` (default) or `plainText` — affects the text of returned comments.
- **`searchTerms`**: server-side keyword filter (see [§6](#6-comment-filtering-server-side-vs-client-side)).
- **`moderationStatus`**: `published` (default), `heldForReview`, `likelySpam` — **authorized requests only**.
- **Response shape** — `commentThreadListResponse`:

  ```
  {
    "kind": "youtube#commentThreadListResponse",
    "etag": "...",
    "nextPageToken": "...",
    "pageInfo": { "totalResults": int, "resultsPerPage": int },
    "items": [ commentThread ]
  }
  ```

- **`commentThread` resource** ([resource docs](https://developers.google.com/youtube/v3/docs/commentThreads)):

  ```
  {
    "id": "...",
    "snippet": {
      "channelId": "...",
      "videoId": "...",
      "topLevelComment": { ...comment resource... },   // the top-level comment, incl. snippet.textOriginal
      "canReply": bool,
      "totalReplyCount": int,
      "isPublic": bool
    },
    "replies": { "comments": [ ...comment resources... ] }   // limited subset, see below
  }
  ```

**Replies are nested but incomplete.** The docs are explicit: "The `commentThread` resource does not necessarily contain all replies to a comment, and you need to use the `comments.list` method if you want to retrieve all replies for a particular comment." The `replies.comments[]` list "contains a limited number of replies, and unless the number of items in the list equals the value of the `snippet.totalReplyCount` property, the list of replies is only a subset." ([commentThreads resource docs](https://developers.google.com/youtube/v3/docs/commentThreads); same note in the [Comments implementation guide](https://developers.google.com/youtube/v3/guides/implementation/comments)).

### `comments.list` — all replies to a comment (and comments by id)

- **HTTP request**: `GET https://www.googleapis.com/youtube/v3/comments` ([reference](https://developers.google.com/youtube/v3/docs/comments/list)).
- **Quota cost**: 1 unit.
- **`part`** (required): `id`, `snippet`.
- **Filters** (exactly one): `parentId` (all replies to a top-level comment) or `id` (specific comments).
- **Pagination**: `pageToken`; `maxResults` 1–100, default 20.
- **`textFormat`**: `html` (default) or `plainText`.
- Reply depth: "currently YouTube features only one level of replies (ie replies to top level comments)" (discovery document) — replies-to-replies are not returned.

### Ordering semantics

`order=time` returns threads "ordered by time" (newest or oldest first is not spelled out in the reference; the implementation guide example lists threads for a video without asserting direction). `order=relevance` orders by YouTube's relevance algorithm. ([commentThreads.list — `order`](https://developers.google.com/youtube/v3/docs/commentThreads/list#order)).

---

## 3. Quota

### Defaults (per Google Cloud project that has the API enabled)

> "Projects that enable the YouTube Data API have a default quota allocation of **100 `search.list` calls, 100 `videos.insert` calls, and 10,000 units per day combined for all other endpoints**."

([Quota Calculator](https://developers.google.com/youtube/v3/determine_quota_cost); also [Getting Started — Quota usage](https://developers.google.com/youtube/v3/getting-started) and [Quota and Compliance Audits](https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits))

- **10,000 units/day** is the shared budget for every endpoint except the two bucketed ones. Daily quotas **reset at midnight Pacific Time (PT)** ([Quota Calculator](https://developers.google.com/youtube/v3/determine_quota_cost)).
- **Every API request, even an invalid one, costs at least 1 quota point** ([Quota Calculator](https://developers.google.com/youtube/v3/determine_quota_cost); [Getting Started](https://developers.google.com/youtube/v3/getting-started)).
- **Each additional page of results from a paged method incurs the per-call quota cost again** ([Quota Calculator](https://developers.google.com/youtube/v3/determine_quota_cost)).
- Costs relevant to this project (from the [Quota Calculator table](https://developers.google.com/youtube/v3/determine_quota_cost)): `commentThreads.list` 1 · `comments.list` 1 · `playlistItems.list` 1 · `channels.list` 1 · `search.list` 1 (in the Search Queries bucket, 100/day) · `videos.list` 1 · `videos.insert` 1 (in its own 100/day bucket) · write operations (`commentThreads.insert`, etc.) 50.
- Quota usage is visible on the Cloud console [Quotas page](https://console.cloud.google.com/iam-admin/quotas). Beyond the default allocation you must pass an **API Compliance Audit** and use the Audit/Quota-Extension forms ([Quota and Compliance Audits](https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits)).

### How `quotaExceeded` surfaces

Documented in the Core API errors table ([YouTube Data API — Errors](https://developers.google.com/youtube/v3/docs/errors)):

| HTTP | Reason | Meaning |
|---|---|---|
| `forbidden (403)` | `quotaExceeded` | "The request cannot be completed because you have exceeded your quota." |

The standard Google API error envelope (JSON with `error.code`, `error.message`, `error.errors[].reason`) is described in the [Google API design guide — Errors](https://cloud.google.com/apis/design/errors).

### Rate limits beyond the daily quota

- Google Cloud quotas can include rate quotas — "requests per day, **requests per minute**, and **requests per minute per user**" — visible per API on the console's [Quotas & System Limits](https://console.cloud.google.com/iam-admin/quotas) page ([Cloud Quotas docs](https://docs.cloud.google.com/docs/quota)).
- The YouTube errors doc also lists `tooManyRequests (429)` `uploadRateLimitExceeded` (thumbnails.set) and a `rateLimitExceeded` error — "The user has sent too many requests in a given timeframe" ([YouTube Data API — Errors](https://developers.google.com/youtube/v3/docs/errors)). The old dedicated `rate_limits` documentation page (developers.google.com/youtube/v3/rate_limits) now returns 404; the canonical limits info lives in the Quota Calculator + console. See [Uncertain claims](#uncertain-claims--follow-ups).
- Note: there are also **undocumented/platform-level limits** that are not part of the published quota docs (e.g. per-minute burst limits surfaced as 429). These are community-documented, not primary sources — flagged in [Uncertain claims](#uncertain-claims--follow-ups).

---

## 4. Auth: API key vs OAuth 2.0

- **Every request must either specify an API key (via the `key` query parameter) or provide an OAuth 2.0 token.** "You must send an authorization token for every insert, update, and delete request. You must also send an authorization token for any request that retrieves the authenticated user's private data." ([API reference — Call the API](https://developers.google.com/youtube/v3/docs))
- **For read-only public data (public channel info, public uploads playlists, public comments) an API key is sufficient** — no OAuth flow needed. Credential options are documented in [Obtaining authorization credentials](https://developers.google.com/youtube/registering_an_application): OAuth 2.0 tokens are "for private user data"; API keys identify your project and provide access, quota, and reports. First-party doc samples for public reads (search.list, playlistItems.list) pass an API key and no OAuth token (e.g. the [Go](https://developers.google.com/youtube/v3/docs/playlistItems/list) and [.NET](https://developers.google.com/youtube/v3/docs/search/list) samples).
- **OAuth 2.0 is required** for: `channels.list` with `mine=true` ([channels.list](https://developers.google.com/youtube/v3/docs/channels/list)), `commentThreads.list` with `moderationStatus` set ([commentThreads.list](https://developers.google.com/youtube/v3/docs/commentThreads/list)), and every write operation ([API reference](https://developers.google.com/youtube/v3/docs)).
- **Service accounts are NOT supported** for YouTube Data API: "YouTube does not support Service Accounts, and if you attempt to authenticate using a Service Account, you will get this error [youtubeSignupRequired]" ([Errors doc](https://developers.google.com/youtube/v3/docs/errors)); the [authentication guide](https://developers.google.com/youtube/v3/guides/authentication) repeats that the YouTube Data API does not support the service-account flow.
- OAuth 2.0 protocol details: [Authentication guide](https://developers.google.com/youtube/v3/guides/authentication).

**v1 recommendation**: API key only. No OAuth scopes, no user consent, no refresh-token handling.

---

## 5. `part=` parameters needed

`part` is required on every resource-returning call; it names the top-level property groups to include, and nested properties come along ([Getting Started — part](https://developers.google.com/youtube/v3/getting-started)). `fields` can further trim nested properties.

| Call | `part` value | What you get |
|---|---|---|
| `channels.list` | `contentDetails` | `contentDetails.relatedPlaylists.uploads` = uploads playlist ID ([implementation guide](https://developers.google.com/youtube/v3/guides/implementation/videos)) |
| `playlistItems.list` | `snippet` (optionally `contentDetails`,`status`) | title, description, thumbnails, `publishedAt`, `snippet.resourceId.videoId` (the video ID) ([playlistItems resource](https://developers.google.com/youtube/v3/docs/playlistItems)) |
| `videos.list` (metadata enrichment) | `snippet,contentDetails,statistics` | full title/description/tags, duration/captions info, view/like/comment counts ([videos resource](https://developers.google.com/youtube/v3/docs/videos)) |
| `commentThreads.list` | `snippet,replies` | `snippet.topLevelComment` (a full `comment` resource incl. `snippet.textOriginal`), plus the limited `replies.comments[]` subset ([commentThreads resource](https://developers.google.com/youtube/v3/docs/commentThreads)) |
| `comments.list` (all replies) | `snippet` | full comment resources incl. `snippet.textOriginal` ([comments resource](https://developers.google.com/youtube/v3/docs/comments)) |

Comment text lives in the `comment` resource's `snippet.textOriginal` (original text) and `snippet.textDisplay` (display text); see [comment resource docs](https://developers.google.com/youtube/v3/docs/comments). With `textFormat=plainText` the returned text is plain; default is HTML.

---

## 6. Comment filtering (server-side vs client-side)

- **Yes — there is a server-side keyword filter**: the `searchTerms` parameter on `commentThreads.list` "instructs the API to limit the API response to only contain comments that contain the specified search terms" ([commentThreads.list — `searchTerms`](https://developers.google.com/youtube/v3/docs/commentThreads/list#searchTerms); discovery document: "Limits the returned comment threads to those matching the specified key words. Not compatible with the 'id' filter.").
- **Limitations of `searchTerms`**: it is a keyword match, not a full text-query language (no documented operators/fields like author, date, regex). It **cannot be combined with the `id` filter**. For any richer filtering — by author (`snippet.authorChannelId`), by date range, by regex, by reply content — you must **fetch all threads (paginated) and filter client-side**.
- The only other server-side comment selectors are structural, not textual: `videoId`/`id`/`allThreadsRelatedToChannelId` (which thread set) and `moderationStatus` (which moderation state; authorized requests only) ([commentThreads.list](https://developers.google.com/youtube/v3/docs/commentThreads/list)).
- For replies, there is no filter at all beyond `parentId` ([comments.list](https://developers.google.com/youtube/v3/docs/comments/list)).

---

## 7. Gotchas

- **Comments disabled on a video → HTTP 403 `commentsDisabled`**, not an empty result: "The video identified by the `videoId` parameter has disabled comments." ([commentThreads.list — Errors](https://developers.google.com/youtube/v3/docs/commentThreads/list)). Handle 403 `commentsDisabled` as "no comments available" for that video. Related causes of disabled comments include made-for-kids content and uploader settings (platform behavior; the API-level signal is the same `commentsDisabled` error).
- **Videos that simply have no comments** return a successful response with an empty `items[]` array (no error is documented for that case).
- **Held-for-review comments are invisible to unauthenticated requests.** Only `moderationStatus=published` (the default) threads are returned without OAuth; `heldForReview`/`likelySpam` require an authorized request ([commentThreads.list — `moderationStatus`](https://developers.google.com/youtube/v3/docs/commentThreads/list#moderationStatus)).
- **`replies.comments[]` is a subset** — must call `comments.list?parentId=` to get all replies; watch `snippet.totalReplyCount` to know when you're missing replies ([commentThreads resource](https://developers.google.com/youtube/v3/docs/commentThreads)).
- **Page size caps**: commentThreads/comments max out at `maxResults=100` (default 20); playlistItems/search/channels/videos cap at 50 (default 5) — confirmed in the [Discovery document](https://www.googleapis.com/discovery/v1/apis/youtube/v3/rest).
- **`search.list` for a channel caps at 500 videos** when `channelId`+`type=video` (and no partner/developer/mine filter) — another reason to use the uploads playlist ([search.list — `channelId`](https://developers.google.com/youtube/v3/docs/search/list#channelId)).
- **`order=date` on search.list is unreliable for recent uploads** (indexing delays) — official docs point to `playlistItems.list` instead ([search.list — `order`](https://developers.google.com/youtube/v3/docs/search/list#order)).
- **Error cases to map**: `403 quotaExceeded`, `403 commentsDisabled`, `404 videoNotFound` / `channelNotFound` / `commentThreadNotFound` / `playlistNotFound`, `400 invalidPageToken`, `400 operationNotSupported` (legacy `id` filter on commentThreads only works for Google+-era comments) ([Errors doc](https://developers.google.com/youtube/v3/docs/errors); [commentThreads.list errors](https://developers.google.com/youtube/v3/docs/commentThreads/list)).
- **Age-restricted / geoblocked / deleted videos**: the reference documents `404 videoNotFound` for deleted/missing videos; behavior for age-restricted videos is not documented in the reference — see [Uncertain claims](#uncertain-claims--follow-ups).
- **Rate limits beyond quota**: per-minute and per-user-per-minute rate quotas can apply (visible in console) and burst behavior can surface as 429; see [§3](#3-quota) and [Uncertain claims](#uncertain-claims--follow-ups).
- **`quotaExceeded` does not distinguish bucket** in the documented error text — the message is generic ("you have exceeded your quota"); to tell whether the 10,000-unit pool or the search/videos bucket was hit, check the Cloud console usage page.

---

## 8. ToS / Developer Policies on storing comment text

The relevant restrictions live in the **YouTube API Services Developer Policies**, section **III.E "Handling YouTube Data and Content"** ([developer-policies](https://developers.google.com/youtube/terms/developer-policies)):

- **Audiovisual content**: you must not download, import, backup, cache, or store copies of YouTube audiovisual content without written approval (III.E.1). (Not relevant to text comments, but the boundary matters for thumbnails/video metadata.)
- **Refreshing, Storing, and Displaying API Data (III.E.4)**:
  - **Non-Authorized Data** (public data fetched without OAuth — which is what public comments are): "may temporarily store **limited amounts** … for as long as is necessary for the purposes of the API Client but **not longer than 30 calendar days**. … after 30 calendar days, the API Client must either **delete or refresh** the stored data." (III.E.4.d)
  - Statistics (view counts etc.) are subject to the same 30-day cap **unless** retrieved as Authorized Data (III.E.4.b), in which case longer storage is allowed but must be re-verified every 30 days.
  - **Authorized Data** not covered by (b) is also capped at 30 calendar days (III.E.4.c).
  - Display: clients "must display the most updated API Data available in their user-facing presentations" (III.E.4.f).
  - Users must be able to request deletion of stored data about them, deleted "as soon as possible and within 7 calendar days" (III.E.4.g).
- **Scraping** (III.E.6): you must not scrape YouTube Applications or obtain scraped YouTube data — comment data must come through the API.
- **Derived data** (III.E.4.h): must not replace API Data with independently calculated values or derive new metrics presented as YouTube's.
- Other relevant obligations: privacy policy requirements (III.A), "give users control" / delete-on-revocation (III.D.2), quota/audit requirements (III.D.3).
- The **Terms of Service** itself ([api-services-terms-of-service](https://developers.google.com/youtube/terms/api-services-terms-of-service)) ties these policies in as part of the Agreement and requires deletion of API Data upon termination (§24.3).

**v1 implication**: the index may cache comment text (and other public API Data) for up to **30 days**, then must delete or refresh; the app must offer user-data deletion and keep displayed data fresh. The spec should model a 30-day TTL/refresh policy and a user-deletion path.

---

## Sources

Primary sources cited throughout (all `developers.google.com` / `cloud.google.com` / Google's own API surface):

1. [YouTube Data API v3 — Quota Calculator (`determine_quota_cost`)](https://developers.google.com/youtube/v3/determine_quota_cost)
2. [YouTube Data API v3 — Getting Started (quota, `part`, `fields`)](https://developers.google.com/youtube/v3/getting-started)
3. [YouTube Data API v3 — Quota and Compliance Audits](https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits)
4. [YouTube Data API v3 — Errors](https://developers.google.com/youtube/v3/docs/errors)
5. [commentThreads.list reference](https://developers.google.com/youtube/v3/docs/commentThreads/list) · [commentThreads resource](https://developers.google.com/youtube/v3/docs/commentThreads)
6. [comments.list reference](https://developers.google.com/youtube/v3/docs/comments/list) · [comments resource](https://developers.google.com/youtube/v3/docs/comments)
7. [playlistItems.list reference](https://developers.google.com/youtube/v3/docs/playlistItems/list) · [search.list reference](https://developers.google.com/youtube/v3/docs/search/list) · [channels.list reference](https://developers.google.com/youtube/v3/docs/channels/list) · [videos.list reference](https://developers.google.com/youtube/v3/docs/videos/list)
8. [Implementation: Videos (uploaded-videos pattern)](https://developers.google.com/youtube/v3/guides/implementation/videos) · [Implementation: Comments](https://developers.google.com/youtube/v3/guides/implementation/comments)
9. [API reference overview — Call the API (key vs OAuth requirement)](https://developers.google.com/youtube/v3/docs)
10. [Obtaining authorization credentials (API keys vs OAuth)](https://developers.google.com/youtube/registering_an_application) · [Authentication guide](https://developers.google.com/youtube/v3/guides/authentication)
11. [YouTube API Services Terms of Service](https://developers.google.com/youtube/terms/api-services-terms-of-service) · [Developer Policies](https://developers.google.com/youtube/terms/developer-policies)
12. [Google API design guide — Errors (error envelope, 429 rateLimitExceeded)](https://cloud.google.com/apis/design/errors) · [Cloud Quotas docs (per-minute/per-user rate quotas)](https://docs.cloud.google.com/docs/quota)
13. [YouTube Data API v3 — Discovery document (machine-readable, confirmed maxResults/order/defaults)](https://www.googleapis.com/discovery/v1/apis/youtube/v3/rest)

---

## Uncertain claims & follow-ups

Claims I could **not** fully verify from a primary source — grill later or mark as assumptions in the spec:

1. **"Non-Authorized Data" is not formally defined.** The Developer Policies use the term (III.E.4.d) but the Definitions section only defines "Authorized Data" ("API Data that an active user expressly authorizes an API Client to access … via User Credentials" — [developer-policies](https://developers.google.com/youtube/terms/developer-policies)). The natural reading is that public data fetched with just an API key (public comments, public video metadata) is Non-Authorized Data, but that inference is mine, not the doc's.
2. **Comment threads on age-restricted / geoblocked / private videos**: not documented in the reference. The only documented "no comments" signal is `403 commentsDisabled`. Community reports that some videos return an empty list (or `403 forbidden`) instead are not backed by a primary source I could find.
3. **Uploads playlist ordering** (newest-first): commonly observed and relied upon, but the reference does not explicitly document the sort order of the uploads playlist. Do not depend on it without empirical confirmation.
4. **`searchTerms` matching semantics** (matches against top-level comment text only? replies too? substring vs token match?) are not detailed in the docs — only "comments that contain the specified search terms".
5. **Per-minute rate limits for the YouTube Data API**: the console can show "requests per minute" / "per user" rate quotas (primary: [Cloud Quotas docs](https://docs.cloud.google.com/docs/quota)), but I could not find a primary page stating the exact per-minute values for youtube.googleapis.com. The old `rate_limits` page is gone (404). The `rateLimitExceeded` entry in the [Errors doc](https://developers.google.com/youtube/v3/docs/errors) is listed under `videoAbuseReportReasons.list` with an odd `badRequest (400)` status — read verbatim from the doc but not cross-confirmed.
6. **Undocumented platform limits** (e.g. 429s with headroom showing in the console) are reported by developers (e.g. [googleapis/google-api-python-client#2753](https://github.com/googleapis/google-api-python-client/issues/2753)) but are not primary-source documentation; treat as real-world signals to test during prototyping, not as spec facts.
7. **`order=time` direction** (newest-first vs oldest-first for `commentThreads.list`) is not stated in the reference; verify empirically against a known video.