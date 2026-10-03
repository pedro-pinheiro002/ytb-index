# ytb-index

The canonical vocabulary of the ytb-index service: a one-shot ingester that turns one YouTube channel into a browseable, timestamped catalog.

## Source

**Channel**:
The single YouTube channel one ingest run fetches from, looked up by handle (`@handle`) or channel ID.
_Avoid_: YouTube channel (redundant — every Channel here is on YouTube), source channel, channel entity

## Pipeline

**Ingest**:
The single sequential run that pulls one Channel's uploads, videos, and top-level comments from the YouTube Data API and upserts them into the Catalog.
_Avoid_: sync, import, scrape, crawl

## Catalog

**Catalog**:
The structured collection of videos and comments persisted by one ingest run of a Channel.
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