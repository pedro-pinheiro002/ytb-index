// src/yt — YouTube Data API v3 client + TimeAnchor detection algorithm.
// Owns: HTTP calls to youtube.googleapis.com, response shape → shared types,
// and the TimeAnchor regex/parsing logic (per wayfinder #7).
// Depends on: src/shared (types only).
// Does NOT know about: src/db (no persistence here), src/server (no HTTP serving).
export {};
