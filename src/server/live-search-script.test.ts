/**
 * Tests for LiveSearch's browser script (`server/live-search-script`,
 * ADR-0011): the DOM-free core runs against a fake `fetch`, and the `/search`
 * page carries the hidden section only when terms and a Channel are set.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LIVE_SEARCH_CORE, liveSearchScript } from './live-search-script.ts';
import { renderSearch } from './search-page.tsx';

interface Hit {
  commentId: string;
  videoId: string;
  matchedIn: string;
  matchingReplies: Array<{ text: string }>;
  totalReplyCount: number;
}
interface Result {
  hits: Hit[];
  truncated: boolean;
  calls: number;
}
type Core = (
  fetchFn: (url: string) => Promise<Response>,
  key: string,
  channelId: string,
  query: string,
  maxPages: number,
) => Promise<Result>;

const core = new Function(`return (${LIVE_SEARCH_CORE});`)() as Core;

function comment(id: string, text: string) {
  return {
    id,
    snippet: { authorDisplayName: `author-${id}`, textOriginal: text, publishedAt: '2026-10-01' },
  };
}

function thread(
  id: string,
  text: string,
  {
    videoId = 'vid1',
    replies = [],
    total = replies.length,
  }: {
    videoId?: string | null;
    replies?: ReturnType<typeof comment>[];
    total?: number;
  } = {},
) {
  return {
    id,
    snippet: {
      ...(videoId !== null ? { videoId } : {}),
      topLevelComment: comment(id, text),
      totalReplyCount: total,
    },
    ...(replies.length > 0 ? { replies: { comments: replies } } : {}),
  };
}

/** Serve `bodies` in order as JSON with `status`; record each URL. */
function fakeFetch(bodies: unknown[], status = 200) {
  const urls: URL[] = [];
  const fetchFn = async (url: string): Promise<Response> => {
    urls.push(new URL(url));
    const body = bodies[urls.length - 1];
    if (body === undefined) throw new Error('fake fetch: bodies exhausted');
    return new Response(JSON.stringify(body), { status });
  };
  return { fetchFn, urls };
}

describe('LiveSearch core', () => {
  it('asks YouTube directly for a channel-wide, server-filtered stream with Replies', async () => {
    const { fetchFn, urls } = fakeFetch([{ items: [thread('c1', 'great filme')] }]);

    const result = await core(fetchFn, 'the-key', 'UC123', 'filme', 3);

    const url = urls[0]!;
    assert.equal(url.origin + url.pathname, 'https://www.googleapis.com/youtube/v3/commentThreads');
    assert.equal(url.searchParams.get('allThreadsRelatedToChannelId'), 'UC123');
    assert.equal(url.searchParams.get('searchTerms'), 'filme');
    assert.equal(url.searchParams.get('part'), 'snippet,replies');
    assert.equal(url.searchParams.get('key'), 'the-key');
    assert.deepEqual(
      result.hits.map((hit) => [hit.commentId, hit.matchedIn]),
      [['c1', 'comment']],
    );
    assert.equal(result.truncated, false);
    assert.equal(result.calls, 1);
  });

  it('says where a thread matched: comment, inline Reply, or a Reply not returned', async () => {
    const { fetchFn } = fakeFetch([
      {
        items: [
          thread('c1', 'Homem-Aranha 2 is better'),
          thread('c2', 'subscribe!', {
            replies: [comment('r1', 'no'), comment('r2', 'homem aranha')],
          }),
          thread('c3', 'unrelated', { replies: [comment('r3', 'no')], total: 9 }),
          thread('c4', 'Ação no HOMEM aranhas'),
        ],
      },
    ]);

    const { hits } = await core(fetchFn, 'k', 'UC123', 'homem aranha', 3);

    assert.deepEqual(
      hits.map((hit) => hit.matchedIn),
      ['comment', 'reply', 'hidden-reply', 'comment'],
    );
    assert.deepEqual(
      hits[1]!.matchingReplies.map((reply) => reply.text),
      ['homem aranha'],
    );
    assert.equal(hits[2]!.totalReplyCount, 9);
  });

  it('stops at maxPages, reports truncation, dedupes, and skips channel discussions', async () => {
    const { fetchFn, urls } = fakeFetch([
      {
        items: [thread('c1', 'filme'), thread('d1', 'filme', { videoId: null })],
        nextPageToken: 'P2',
      },
      { items: [thread('c1', 'filme'), thread('c2', 'filme')], nextPageToken: 'P3' },
    ]);

    const result = await core(fetchFn, 'k', 'UC123', 'filme', 2);

    assert.equal(urls[1]!.searchParams.get('pageToken'), 'P2');
    assert.deepEqual(
      result.hits.map((hit) => hit.commentId),
      ['c1', 'c2'],
    );
    assert.equal(result.truncated, true);
    assert.equal(result.calls, 2);
  });

  it('rejects with the Google reason, and treats commentsDisabled as no hits', async () => {
    const quota = fakeFetch([{ error: { code: 403, errors: [{ reason: 'quotaExceeded' }] } }], 403);
    await assert.rejects(core(quota.fetchFn, 'k', 'UC123', 'filme', 3), {
      reason: 'quotaExceeded',
    });

    const disabled = fakeFetch(
      [{ error: { code: 403, errors: [{ reason: 'commentsDisabled' }] } }],
      403,
    );
    assert.deepEqual((await core(disabled.fetchFn, 'k', 'UC123', 'filme', 3)).hits, []);
  });

  it('rejects with reason network when fetch itself fails', async () => {
    const failing = async (): Promise<Response> => {
      throw new TypeError('offline');
    };
    await assert.rejects(core(failing, 'k', 'UC123', 'filme', 3), { reason: 'network' });
  });

  it('compiles as part of the page script', () => {
    assert.doesNotThrow(() => new Function(liveSearchScript()));
  });
});

describe('/search LiveSearch section', () => {
  const channels = [{ id: 'UC123', title: 'Chan <One>' }];
  const render = (query: string): string =>
    renderSearch({
      params: new URLSearchParams(query),
      channels,
      state: { type: 'empty' },
    });

  it('is rendered hidden, with its script, for terms on one Channel', () => {
    const body = render('q=filme&channel=UC123');
    assert.match(
      body,
      /<section\s+id="live-search"[^>]*data-channel="UC123"[^>]*data-q="filme"[^>]*hidden/,
    );
    assert.ok(body.includes('Search Chan &lt;One&gt; live on YouTube'));
    assert.ok(body.includes('localStorage.getItem(KEY_STORAGE_KEY)'));
  });

  it('is left out without terms, without a Channel, or for an unknown Channel', () => {
    for (const query of ['channel=UC123', 'q=filme', 'q=filme&channel=UC999']) {
      const body = render(query);
      assert.ok(!body.includes('id="live-search"'), query);
      assert.ok(!body.includes('KEY_STORAGE_KEY'), query);
    }
  });
});
