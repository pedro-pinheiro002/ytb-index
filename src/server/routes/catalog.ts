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
import { listCatalog } from '../../db/queries.ts';
import type { DbHandle } from '../../db/sqlite.ts';
import type { Channel } from '../../shared/types.ts';
import { renderCatalog, type CatalogVideo } from '../ssr.tsx';

interface ChannelRow {
  id: string;
  title: string;
  uploads_playlist_id: string;
  fetched_at: string;
}

interface TimestampedCountRow {
  video_id: string;
  timestamped: number | null;
}

const SELECT_CHANNEL_SQL = `
  SELECT id, title, uploads_playlist_id, fetched_at
  FROM channels
  ORDER BY fetched_at DESC
  LIMIT 1
`;

const TIMESTAMPED_COUNTS_SQL = `
  SELECT video_id, SUM(has_anchors) AS timestamped
  FROM comments
  GROUP BY video_id
`;

/** The most recently refreshed channel, or `null` when nothing is ingested. */
function selectChannel(db: DbHandle): Channel | null {
  const row = db.prepare(SELECT_CHANNEL_SQL).get() as ChannelRow | undefined;
  if (row === undefined) {
    return null;
  }
  return {
    id: row.id,
    title: row.title,
    uploadsPlaylistId: row.uploads_playlist_id,
    fetchedAt: row.fetched_at,
  };
}

/** Map of `video_id` → number of that video's comments holding an anchor. */
function timestampedCounts(db: DbHandle): Map<string, number> {
  const rows = db.prepare(TIMESTAMPED_COUNTS_SQL).all() as TimestampedCountRow[];
  return new Map(rows.map((row) => [row.video_id, Number(row.timestamped ?? 0)]));
}

/**
 * Mount `GET /` on `app`. `db` is the live handle owned by the app factory
 * (see `createApp`); the handler issues synchronous reads per request.
 */
export function catalogRoute(app: Hono, db: DbHandle): void {
  app.get('/', (c) => {
    const channel = selectChannel(db);
    const counts = timestampedCounts(db);
    const videos: CatalogVideo[] = listCatalog(db).map((video) => ({
      ...video,
      timestampedCount: counts.get(video.id) ?? 0,
    }));
    return c.html(renderCatalog(channel, videos));
  });
}
