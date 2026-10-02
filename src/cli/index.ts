// src/cli — Ingest command-line entrypoint.
// Owns: argument parsing, orchestration of the ingest pipeline (resolve channel
// → fetch uploads → fetch comments → detect TimeAnchors → persist via src/db).
// Depends on: src/yt (API + TimeAnchor detection), src/db (writes), src/shared (types).
// Does NOT know about: src/server (no HTTP).
export {};
