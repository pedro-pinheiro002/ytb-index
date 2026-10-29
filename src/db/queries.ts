/**
 * Compatibility shim (`db/queries`): R2 (#46) split this module into the
 * Ingest write model (`./ingest-writes.ts`) and the Catalog read model
 * (`./catalog-reads.ts`). Existing imports keep working through these
 * re-exports; new code imports the side it needs directly.
 */
export * from './ingest-writes.ts';
export * from './catalog-reads.ts';
