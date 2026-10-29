/**
 * `GET /` — catalog index route (`server/routes/catalog`).
 *
 * Reads the single ingested channel (if any) plus the catalog video list, then
 * delegates all HTML shaping to `renderCatalog`. The route owns no markup.
 *
 * The per-video timestamped count is a derived value (comments with
 * `has_anchors = 1`), computed here so the SSR component stays pure and
 * data-in / string-out.
 */
import type { Hono } from 'hono';
import type { Executor } from '../../db/executor.ts';
import type { VideoRecord } from '../../shared/types.ts';
import { loadCatalog, listChannels, loadLatestIngestStatus } from '../data.ts';
import type { CatalogVideo } from '../ssr.tsx';
import { renderCatalog, renderNotFound } from '../ssr.tsx';

interface TimestampedCountRow {
  video_id: string;
  timestamped: number | null;
}

const TIMESTAMPED_COUNTS_SQL = `
  SELECT video_id, SUM(has_anchors) AS timestamped
  FROM comments
  GROUP BY video_id
`;

/** Map of `video_id` → number of that video's comments holding an anchor. */
async function timestampedCounts(db: Executor): Promise<Map<string, number>> {
  const rows = await db.all<TimestampedCountRow>(TIMESTAMPED_COUNTS_SQL);
  return new Map(rows.map((row) => [row.video_id, Number(row.timestamped ?? 0)]));
}

async function withTimestampedCounts(db: Executor, videos: VideoRecord[]): Promise<CatalogVideo[]> {
  const counts = await timestampedCounts(db);
  return videos.map((video) => ({
    ...video,
    timestampedCount: counts.get(video.id) ?? 0,
  }));
}

/**
 * Mount `GET /` and `GET /c/:channelId` on `app`. `db` is the executor owned
 * by the app factory (see `createApp`); the handler awaits the per-request reads.
 */
export function catalogRoute(app: Hono, db: Executor): void {
  app.get('/', async (c) => {
    const catalog = await loadCatalog(db);
    const channel = catalog?.channel ?? null;
    const videos = catalog === null ? [] : await withTimestampedCounts(db, catalog.videos);
    const channels = (await listChannels(db)).map((ch) => ({ id: ch.channelId, title: ch.title }));
    const status = await loadLatestIngestStatus(db);
    return c.html(renderCatalog(channel, videos, channels, status));
  });

  app.get('/c/:channelId', async (c) => {
    const channelId = c.req.param('channelId');
    const catalog = await loadCatalog(db, channelId);
    if (catalog === null) {
      return c.html(renderNotFound('Unknown channel.'), 404);
    }
    const videos = await withTimestampedCounts(db, catalog.videos);
    const channels = (await listChannels(db)).map((ch) => ({ id: ch.channelId, title: ch.title }));
    const status = await loadLatestIngestStatus(db);
    return c.html(renderCatalog(catalog.channel, videos, channels, status));
  });
}
