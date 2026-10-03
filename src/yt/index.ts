/**
 * src/yt — YouTube Data API v3 client + TimeAnchor detection + API key validation
 * + channel input parser + in-memory quota counter.
 *
 * Tickets: #13 (T01 api-key), #15 (T02 anchors), #14 (T03 parse-channel),
 *         #16 (T04 quota), #18 (T05 client).
 */
export { validateApiKey, API_KEY_FAILURE_MESSAGES } from './api-key.ts';
export type { ApiKeyValidation } from './api-key.ts';

export { detectAnchors } from './anchors.ts';
export type { Anchor } from './anchors.ts';

export { parseChannelInput, UsageError } from './parse-channel.ts';
export type { ChannelInput } from '../shared/types.ts';

export { QuotaCounter, QuotaExceededError } from './quota.ts';

export { createYouTubeClient, retryTransport, ApiError } from './client.ts';
export type {
  Transport,
  Sleep,
  YouTubeClient,
  ListChannelParams,
  ListPlaylistItemsParams,
  ListVideosParams,
  ListCommentThreadsParams,
  ChannelResource,
  ChannelListResponse,
  PlaylistItem,
  PlaylistItemListResponse,
  VideoThumbnail,
  VideoResource,
  VideoListResponse,
  CommentResource,
  CommentThread,
  CommentThreadListResponse,
  GoogleErrorEnvelope,
} from './client.ts';
