/**
 * `GET /v/:videoId` — video detail route (`server/routes/video`).
 *
 * Looks the video up in the catalog, loads its comments (via the TTL-redacting
 * `comments_active` view) and their anchors, then delegates HTML shaping to
 * `renderVideo`. Unknown ids return a `text/html` 404 page.
 */
import type { Hono } from 'hono';
import { html } from 'hono/html';
import { listCatalog, listVideoComments } from '../../db/queries.ts';
import type { DbHandle } from '../../db/sqlite.ts';
import type { TimeAnchor } from '../../shared/types.ts';
import { renderVideo } from '../ssr.tsx';

interface AnchorRow {
  comment_id: string;
  seconds: number;
  raw_text: string;
  char_position: number;
}

const SELECT_ANCHORS_SQL = `
  SELECT ta.comment_id, ta.seconds, ta.raw_text, ta.char_position
  FROM time_anchors ta
  JOIN comments c ON c.id = ta.comment_id
  WHERE c.video_id = ?
  ORDER BY ta.comment_id, ta.char_position
`;

const NOT_FOUND_HTML = html`<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <title>Not found — ytb-index</title>
    </head>
    <body>
      <h1>404 Not Found</h1>
    </body>
  </html>`.toString();

/**
 * Every anchor for the video's comments, flat. Expired comments keep their
 * anchors (ADR-0001: the anchor existed; only the body is redacted).
 */
function listAnchorsForVideo(db: DbHandle, videoId: string): TimeAnchor[] {
  const rows = db.prepare(SELECT_ANCHORS_SQL).all(videoId) as AnchorRow[];
  return rows.map((row) => ({
    commentId: row.comment_id,
    seconds: row.seconds,
    rawText: row.raw_text,
    charPosition: row.char_position,
  }));
}

/**
 * Mount `GET /v/:videoId` on `app`. `db` is the live handle owned by the app
 * factory (see `createApp`).
 */
export function videoRoute(app: Hono, db: DbHandle): void {
  app.get('/v/:videoId', (c) => {
    const videoId = c.req.param('videoId');
    const video = listCatalog(db).find((candidate) => candidate.id === videoId);
    if (video === undefined) {
      return c.html(NOT_FOUND_HTML, 404);
    }
    const comments = listVideoComments(db, videoId);
    const anchors = listAnchorsForVideo(db, videoId);
    return c.html(renderVideo(video, comments, anchors));
  });
}
