# ytb-index

The canonical vocabulary of the ytb-index service: an ingester that turns YouTube channels into browseable, searchable, timestamped catalogs, one ingest run at a time.

## Source

**Channel**:
One YouTube channel in the Catalog, keyed by channel ID and namable at ingest time by handle (`@handle`), channel ID, or URL.
_Avoid_: YouTube channel (redundant — every Channel here is on YouTube), source channel, channel entity

**Broadcast**:
A VideoRecord that was streamed live or premiered rather than only uploaded; it has a real start time and, once over, a real end time.
_Avoid_: live, livestream, stream, premiere (as a separate kind: YouTube does not tell the two apart)

## Pipeline

**Ingest**:
The single sequential run that pulls one Channel's videos, their comments and Replies, and the LiveChatMessages of any Broadcast still on air, from the YouTube Data API, and upserts them into the Catalog.
_Avoid_: sync, import, scrape, crawl

## Operation

**Operator**:
The single human entitled to submit IngestRequests; Catalog writes happen only on an Operator's instruction.
_Avoid_: admin, owner, user (collides with YouTube's account notion)

**OperatorKey**:
The YouTube Data API key the Operator supplies to pay for an Ingest out of their own Google Cloud project's quota.
_Avoid_: user key, token, credentials, API token

**Visitor**:
Anyone reading or searching the Catalog without Operator rights.
_Avoid_: reader, guest, end user

**IngestRequest**:
An Operator's instruction, submitted through the web app, for one ingest run of one Channel; the unit of ingest feedback, progressing queued → running → done/failed.
_Avoid_: ingest job, ingest task, trigger, refresh request

## Catalog

**Catalog**:
The structured collection of Channels with their videos, comments and LiveChatMessages, persisted one ingest run at a time.
_Avoid_: database, dataset, archive, index (the project name is overloaded; Catalog refers to the data, not the app)

**VideoRecord**:
One video in the Catalog, identified by `videoId` and carrying `title`, `publishedAt`, `description`, `thumbnailUrl`, and `url`; either a plain upload or a Broadcast.
_Avoid_: Video (collides with YouTube's own notion), Video entry, Video row

**CommentRecord**:
One YouTube comment in the Catalog, top-level or a Reply, identified by `commentId` and carrying `author`, `authorChannelId`, `publishedAt`, `text`, `likeCount`, and `videoId`.
_Avoid_: Comment (collides with YouTube's own notion), Comment entry, Comment row, top-level comment table

**Reply**:
A CommentRecord that answers a top-level CommentRecord; YouTube allows one level only.
_Avoid_: child comment, sub-comment, response, thread item

**LiveChatMessage**:
One message posted to a Broadcast's live chat while it was on air, carrying its author, text, and offset in seconds from the Broadcast's start.
_Avoid_: chat comment, live comment, chat row, superchat (a kind of message, not a separate term)

## Search

**SearchQuery**:
A Visitor's combination of terms, date range, author, and record kinds, evaluated against the Catalog alone and never against YouTube.
_Avoid_: search request, filter, query string, lookup

**SearchHit**:
One CommentRecord, LiveChatMessage, or VideoRecord matched by a SearchQuery, together with where it points in its source video.
_Avoid_: result row, match, hit row, search result entry

## Derived

**TimestampedComment**:
A CommentRecord whose text holds at least one TimeAnchor; the unit rendered into a video-page anchor list.
_Avoid_: anchored comment, comment-with-timestamp, timecode comment, linked comment

**TimeAnchor**:
A matched timestamp in a CommentRecord's text, parsed to `seconds: number`.
_Avoid_: timestamp (collides with `videoTime`-adjacent notions), time marker, timecode, chat offset (a LiveChatMessage's offset is known, not parsed)
