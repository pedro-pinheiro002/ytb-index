// src/db — Catalog persistence behind the async `Executor` interface.
// Owns: the portable SQL (`catalog-reads.ts`, `ingest-writes.ts`, `filter.ts`;
// `queries.ts` re-exports the first two), the local better-sqlite3 executor +
// migrations (`sqlite.ts`, the only Node-bound file here), the D1 binding
// executor (`d1.ts`, Worker) and the D1 HTTP writer (`d1-http.ts`, `--remote`).
// Depends on: src/shared (types only).
// Does NOT know about: src/server (no HTTP), src/cli (no orchestration).
export {};
