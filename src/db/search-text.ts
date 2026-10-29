/**
 * The Catalog's search-text normalizer (ADR-0010, spec v2 "Text normalizer").
 *
 * Owns `normalizeSearchText`, the single function that turns a record's text
 * into its stored `search_text` at Ingest and turns SearchQuery terms into
 * the strings matched with `LIKE` against it. One shared function keeps the
 * write side and the query side from drifting apart. Pure and Worker-safe
 * (no Node imports). Ticket F1 (#47).
 */

/** Unicode combining marks (accents, diacritics) left behind by NFKD. */
const COMBINING_MARKS = /\p{M}+/gu;

/** Every run of characters that is neither a letter nor a digit. */
const NON_WORD_RUN = /[^\p{L}\p{N}]+/gu;

/**
 * Normalize text for search: Unicode NFKD, combining marks removed,
 * lowercased, every run of non-letter/non-digit characters collapsed into one
 * space, trimmed. Idempotent: `f(f(x)) === f(x)`.
 *
 * @example normalizeSearchText('Ação, World!!') // 'acao world'
 * @param text Any record text or SearchQuery term.
 * @returns The normalized form stored in / matched against `search_text`.
 */
export function normalizeSearchText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(NON_WORD_RUN, ' ')
    .trim();
}
