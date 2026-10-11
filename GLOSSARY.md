# ytb-index

The canonical vocabulary of the ytb-index service: an ingester that turns YouTube channels into browseable, timestamped catalogs, one ingest run at a time.

## Source

**Channel**:
One YouTube channel in the Catalog, keyed by channel ID and namable at ingest time by handle (`@handle`), channel ID, or URL.
_Avoid_: YouTube channel (redundant — every Channel here is on YouTube), source channel, channel entity

## Pipeline

**Ingest**:
The single sequential run that pulls one Channel's uploads, videos, and top-level comments from the YouTube Data API and upserts them into the Catalog.
_Avoid_: sync, import, scrape, crawl

## Operation

**Operator**:
The single human entitled to submit IngestRequests; Catalog writes happen only on an Operator's instruction.
_Avoid_: admin, owner, user (collides with YouTube's account notion)

**Visitor**:
Anyone reading the Catalog without Operator rights.
_Avoid_: reader, guest, end user

**IngestRequest**:
An Operator's instruction, submitted through the web app, for one ingest run of one Channel; the unit of ingest feedback, progressing queued → running → done/failed.
_Avoid_: ingest job, ingest task, trigger, refresh request

## Catalog

**Catalog**:
The structured collection of Channels with their videos and comments, persisted one ingest run at a time.
_Avoid_: database, dataset, archive, index (the project name is overloaded; Catalog refers to the data, not the app)

**VideoRecord**:
One video in the Catalog, identified by `videoId` and carrying `title`, `publishedAt`, `description`, `thumbnailUrl`, and `url`.
_Avoid_: Video (collides with YouTube's own notion), Video entry, Video row

**CommentRecord**:
One top-level YouTube comment in the Catalog, identified by `commentId` and carrying `author`, `publishedAt`, `text`, `likeCount`, and `videoId`.
_Avoid_: Comment (collides with YouTube's own notion), Comment entry, Comment row, top-level comment table

## Derived

**TimestampedComment**:
A CommentRecord whose text holds at least one TimeAnchor; the unit rendered into a video-page anchor list.
_Avoid_: anchored comment, comment-with-timestamp, timecode comment, linked comment

**TimeAnchor**:
A matched timestamp in a CommentRecord's text, parsed to `seconds: number`.
_Avoid_: timestamp (collides with `videoTime`-adjacent notions), time marker, timecode