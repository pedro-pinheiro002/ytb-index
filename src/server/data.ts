/**
 * Server-side data loaders (`server/data`).
 *
 * The read model shared by the Hono routes: the catalog page's channel plus
 * its videos, the channel list for the switcher, and the latest IngestRequest
 * behind `GET /api/ingest/status` (ADR-0005).
 *
 * SQL stays portable (positional `?` parameters only, no pragmas) so the same
 * strings run on better-sqlite3 and D1. Boundary: `server -> db -> shared`
 * only — no `src/yt` import (ADR-0002/0003) and no Node builtins, so this
 * module stays inside the Worker import graph.
 */
import type { Executor } from '../db/executor.ts';
import {
  listChannelVideos,
  listChannels as listChannelRows,
  loadLatestIngestStatus as loadLatestIngestRequest,
} from '../db/queries.ts';
import type { Channel, IngestRequest, VideoRecord } from '../shared/types.ts';

/** The catalog page's data: one Channel plus that channel's videos. */
export interface Catalog {
  channel: Channel;
  videos: VideoRecord[];
}

/**
 * One entry of the channel list. `id` is the `channels.id` key the switcher
 * uses; `channelId` is the same value under the loader contract's name.
 */
export interface ChannelSummary {
  /** YouTube channel ID (`channels.id`) — the switcher's option value. */
  id: string;
  /** Alias of {@link id}. */
  channelId: string;
  /** Display title (`channels.title`). */
  title: string;
}

interface ChannelRow {
  id: string;
  title: string;
  uploads_playlist_id: string;
  fetched_at: string;
}

const SELECT_LATEST_CHANNEL_SQL = `
  SELECT id, title, uploads_playlist_id, fetched_at
  FROM channels
  ORDER BY fetched_at DESC
  LIMIT 1
`;

const SELECT_CHANNEL_BY_ID_SQL = `
  SELECT id, title, uploads_playlist_id, fetched_at
  FROM channels
  WHERE id = ?
`;

function toChannel(row: ChannelRow): Channel {
  return {
    id: row.id,
    title: row.title,
    uploadsPlaylistId: row.uploads_playlist_id,
    fetchedAt: row.fetched_at,
  };
}

/**
 * The catalog page's data: the most recently refreshed channel when
 * `channelId` is omitted, or the channel with that id otherwise, together
 * with that channel's videos (newest-first by `published_at`).
 *
 * Returns `null` when no channel has been ingested yet, or when `channelId`
 * matches no channel.
 */
export async function loadCatalog(executor: Executor, channelId?: string): Promise<Catalog | null> {
  const row =
    channelId === undefined
      ? await executor.get<ChannelRow>(SELECT_LATEST_CHANNEL_SQL)
      : await executor.get<ChannelRow>(SELECT_CHANNEL_BY_ID_SQL, [channelId]);
  if (row === undefined) {
    return null;
  }
  const channel = toChannel(row);
  return { channel, videos: await listChannelVideos(executor, channel.id) };
}

/** Every ingested channel, most recently refreshed (`fetched_at`) first. */
export async function listChannels(executor: Executor): Promise<ChannelSummary[]> {
  const rows = await listChannelRows(executor);
  return rows.map((row) => ({ id: row.id, channelId: row.id, title: row.title }));
}

/**
 * The most recently updated IngestRequest, or `null` when none exists.
 * Backs `GET /api/ingest/status` and the operator status area.
 */
export async function loadLatestIngestStatus(executor: Executor): Promise<IngestRequest | null> {
  return await loadLatestIngestRequest(executor);
}
