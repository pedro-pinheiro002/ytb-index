/**
 * `GET /v/:videoId` — video detail route (`server/routes/video`).
 *
 * Looks the video up by id (one single-row read, R2 #46), loads its comments
 * (via the TTL-redacting `comments_active` view) and their anchors, then
 * delegates HTML shaping to `renderVideo`. Unknown ids return a `text/html`
 * 404 page. All SQL lives in `db/catalog-reads`.
 */
import type { Hono } from 'hono';
import { getVideo, listVideoAnchors, listVideoComments } from '../../db/catalog-reads.ts';
import type { Executor } from '../../db/executor.ts';
import { renderNotFound, renderVideo } from '../ssr.tsx';

/**
 * Mount `GET /v/:videoId` on `app`. `db` is the executor owned by the app
 * factory (see `createApp`).
 */
export function videoRoute(app: Hono, db: Executor): void {
  app.get('/v/:videoId', async (c) => {
    const videoId = c.req.param('videoId');
    const video = await getVideo(db, videoId);
    if (video === undefined) {
      return c.html(renderNotFound('Unknown video.'), 404);
    }
    const comments = await listVideoComments(db, videoId);
    const anchors = await listVideoAnchors(db, videoId);
    return c.html(renderVideo(video, comments, anchors));
  });
}
