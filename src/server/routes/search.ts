/**
 * `GET /search` — the public search page route (`server/routes/search`):
 * ticket F5 (#53), ADR-0010, spec v2 "SearchQuery contract".
 *
 * Parses the params into a SearchQuery with `parseSearchQuery`, runs it with
 * `searchCatalog` (Catalog only, never YouTube), and hands the outcome to
 * `renderSearch`. A query with nothing to search by shows the empty form
 * without touching the search SQL; invalid params, including a page out of
 * range, answer HTTP 400 with the messages inline, never a 500. The route
 * owns no markup and no SQL.
 */
import type { Hono } from 'hono';
import { isEmptySearch, parseSearchQuery, searchCatalog } from '../../db/catalog-search.ts';
import type { Executor } from '../../db/executor.ts';
import { listChannels } from '../data.ts';
import { renderSearch, type SearchPageState } from '../search-page.tsx';

/**
 * Mount `GET /search` on `app`. `db` is the executor owned by the app
 * factory (see `createApp`).
 */
export function searchRoute(app: Hono, db: Executor): void {
  app.get('/search', async (c) => {
    const params = new URL(c.req.url).searchParams;
    const channels = (await listChannels(db)).map((ch) => ({ id: ch.id, title: ch.title }));
    const render = (state: SearchPageState): string => renderSearch({ params, channels, state });

    const parsed = parseSearchQuery(params);
    if (!parsed.ok) {
      return c.html(render({ type: 'invalid', errors: parsed.errors }), 400);
    }
    if (isEmptySearch(parsed.query)) {
      return c.html(render({ type: 'empty' }));
    }
    try {
      const result = await searchCatalog(db, parsed.query);
      return c.html(render({ type: 'results', terms: parsed.query.terms, result }));
    } catch (error) {
      if (error instanceof RangeError) {
        return c.html(render({ type: 'invalid', errors: [`page: ${error.message}`] }), 400);
      }
      throw error;
    }
  });
}
