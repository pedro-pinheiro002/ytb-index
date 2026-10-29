/**
 * Server-side data loaders (`server/data`).
 *
 * The read model shared by the Hono routes: the catalog page's channel plus
 * its videos, the channel list for the switcher, and the latest IngestRequest
 * behind `GET /api/ingest/status` (ADR-0005).
 *
 * All SQL lives in `db/catalog-reads` (R2 #46); this module only shapes the
 * read model for the routes. Boundary: `server -> db -> shared`
 * only — no `src/yt` import (ADR-0002/0003) and no Node builtins, so this
 * module stays inside the Worker import graph.
 */
import type { Executor } from '../db/executor.ts';
import {
  getChannel,
  getLatestChannel,
  listChannelVideos,
  listChannels as listChannelRows,
  loadLatestIngestStatus as loadLatestIngestRequest,
} from '../db/catalog-reads.ts';
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

/**
 * The catalog page's data: the most recently refreshed channel when
 * `channelId` is omitted, or the channel with that id otherwise, together
 * with that channel's videos (newest-first by `published_at`).
 *
 * Returns `null` when no channel has been ingested yet, or when `channelId`
 * matches no channel.
 */
export async function loadCatalog(executor: Executor, channelId?: string): Promise<Catalog | null> {
  const channel =
    channelId === undefined
      ? await getLatestChannel(executor)
      : await getChannel(executor, channelId);
  if (channel === undefined) {
    return null;
  }
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
