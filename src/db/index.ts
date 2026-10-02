// src/db — SQLite persistence: schema migrations + read/write queries.
// Owns: better-sqlite3 connection lifecycle, schema migrations, the catalog
// read paths the server needs and the write paths the ingest CLI needs.
// Depends on: src/shared (types only).
// Does NOT know about: src/server (no HTTP), src/cli (no orchestration).
export {};
