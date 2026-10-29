/**
 * Term highlighting for SearchHit snippets (`server/highlight`): ticket F5
 * (#53), ADR-0010.
 *
 * A SearchQuery matches normalized `search_text` (accents stripped,
 * lowercased, non-word runs collapsed), but the page shows the original
 * text. {@link matchRanges} bridges the two: it folds the original text one
 * code point at a time with the shared `normalizeSearchText`, remembering
 * which original span each folded character came from, finds the normalized
 * terms in the folded string and maps every match back to the original. So
 * `acao` marks `AÇÃO`, and a decomposed `é` is marked whole.
 *
 * Only offsets come out of here: escaping stays the template's job, which
 * interpolates each slice through Hono's `html` helper.
 */
import { normalizeSearchText } from '../db/search-text.ts';

/** A half-open `[start, end)` span of UTF-16 offsets into the original text. */
export interface TextRange {
  start: number;
  end: number;
}

const MARK = /^\p{M}+$/u;

/**
 * Where `terms` occur in `text`, matched as the Catalog matches them
 * (case-, accent- and punctuation-insensitive substrings).
 *
 * Per-code-point folding agrees with `normalizeSearchText` on whole strings
 * except for context-sensitive case mappings (a final Greek sigma); such a
 * term still matches in SQL but is simply left unmarked here.
 *
 * @param text The original record text.
 * @param terms Normalized SearchQuery terms (`SearchQuery.terms`).
 * @returns Sorted ranges on code point boundaries; overlapping or touching
 *   matches are merged into one.
 */
export function matchRanges(text: string, terms: readonly string[]): TextRange[] {
  let folded = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;

  for (const codePoint of text) {
    const next = offset + codePoint.length;
    const piece = normalizeSearchText(codePoint);
    if (piece !== '') {
      for (let index = 0; index < piece.length; index += 1) {
        folded += piece[index];
        starts.push(offset);
        ends.push(next);
      }
    } else if (MARK.test(codePoint)) {
      // A combining mark belongs to the character before it.
      if (ends.length > 0) ends[ends.length - 1] = next;
    } else if (folded !== '') {
      // A separator run folds to one space (leading separators are trimmed).
      if (folded.endsWith(' ')) {
        ends[ends.length - 1] = next;
      } else {
        folded += ' ';
        starts.push(offset);
        ends.push(next);
      }
    }
    offset = next;
  }

  const found: TextRange[] = [];
  for (const term of terms) {
    if (term === '') continue;
    for (let at = folded.indexOf(term); at !== -1; at = folded.indexOf(term, at + 1)) {
      const start = starts[at];
      const end = ends[at + term.length - 1];
      if (start !== undefined && end !== undefined) found.push({ start, end });
    }
  }

  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: TextRange[] = [];
  for (const range of found) {
    const last = merged.at(-1);
    if (last !== undefined && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}
