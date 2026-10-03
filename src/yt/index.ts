/**
 * src/yt — YouTube Data API v3 client + TimeAnchor detection + API key validation.
 * See chat: #18 (T05 client), #15 (T02 anchors), #13 (T01 api-key).
 */
export { validateApiKey, API_KEY_FAILURE_MESSAGES } from './api-key.ts';
export type { ApiKeyValidation } from './api-key.ts';
