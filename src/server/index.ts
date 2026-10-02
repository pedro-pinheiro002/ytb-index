// src/server — Hono app, route handlers, SSR rendering.
// Owns: HTTP routing (catalog index, video detail), HTML response shaping.
// Depends on: src/db (read queries), src/shared (types).
// Does NOT know about: src/yt (YouTube API client) or src/cli (ingest).
export {};
