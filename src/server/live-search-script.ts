/**
 * LiveSearch's browser script (`server/live-search-script`, ADR-0011).
 *
 * LiveSearch asks YouTube directly, from the Operator's browser, for every
 * comment thread on one Channel that matches the terms
 * (`commentThreads.list?allThreadsRelatedToChannelId=…&searchTerms=…`), using
 * the OperatorKey the browser already keeps (ADR-0007). The Worker never sees
 * the key or the results, and nothing is stored: the hits exist only on the
 * page that asked for them.
 *
 * Two pieces, both plain ES5-style strings so no bundler rewrites them:
 *
 *  - {@link LIVE_SEARCH_CORE}: a function expression with no DOM access,
 *    `(fetchFn, key, channelId, query, maxPages) => Promise<result>`. Tests
 *    evaluate it with a fake `fetch`.
 *  - {@link liveSearchScript}: the core plus the wiring that reveals the
 *    `#live-search` section when an OperatorKey is stored, runs the search on
 *    click and renders the hits with `textContent` only (no markup from
 *    YouTube is ever parsed).
 */

/** YouTube's `commentThreads.list` endpoint. */
const ENDPOINT = 'https://www.googleapis.com/youtube/v3/commentThreads';

/** Default page cap: at most 3 quota units and 300 threads per search. */
export const LIVE_SEARCH_MAX_PAGES = 3;

/**
 * The search itself. Resolves to `{ hits, truncated, calls }`; rejects with
 * `{ reason }` (a Google error reason, or `network`).
 *
 * `searchTerms` also matches Replies, so each hit records where the terms
 * were found: `comment`, `reply` (a Reply YouTube returned inline, ≤5 per
 * thread) or `hidden-reply` (one it did not return). Matching folds case and
 * diacritics like the Catalog's `search_text`, though YouTube itself does
 * not fold diacritics.
 */
export const LIVE_SEARCH_CORE = `function (fetchFn, key, channelId, query, maxPages) {
  function fold(text) {
    return String(text).normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase();
  }
  function tokens(text) {
    return fold(text).split(/[^\\p{L}\\p{N}]+/u).filter(function (t) { return t !== ''; });
  }
  var terms = tokens(query);
  function matches(text) {
    var words = tokens(text);
    return terms.every(function (term) {
      return words.some(function (word) { return word.indexOf(term) === 0; });
    });
  }
  function toReply(c) {
    return {
      id: c.id,
      author: c.snippet.authorDisplayName,
      text: c.snippet.textOriginal,
      publishedAt: c.snippet.publishedAt
    };
  }
  var hits = [];
  var seen = {};
  var calls = 0;
  function page(pageToken) {
    var url = new URL('${ENDPOINT}');
    url.searchParams.set('part', 'snippet,replies');
    url.searchParams.set('allThreadsRelatedToChannelId', channelId);
    url.searchParams.set('searchTerms', query);
    url.searchParams.set('maxResults', '100');
    url.searchParams.set('textFormat', 'plainText');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    url.searchParams.set('key', key);
    calls += 1;
    return fetchFn(url.toString()).then(
      function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          if (!res.ok) {
            var reason = body && body.error && body.error.errors && body.error.errors[0]
              ? body.error.errors[0].reason : 'http' + res.status;
            throw { reason: reason };
          }
          return body;
        });
      },
      function () { throw { reason: 'network' }; }
    );
  }
  function collect(body) {
    (body.items || []).forEach(function (thread) {
      var top = thread.snippet.topLevelComment;
      var videoId = thread.snippet.videoId || top.snippet.videoId;
      if (!videoId || seen[top.id]) return;
      seen[top.id] = true;
      var replies = ((thread.replies && thread.replies.comments) || []).filter(function (r) {
        return matches(r.snippet.textOriginal);
      }).map(toReply);
      var inComment = matches(top.snippet.textOriginal);
      hits.push({
        commentId: top.id,
        videoId: videoId,
        author: top.snippet.authorDisplayName,
        text: top.snippet.textOriginal,
        publishedAt: top.snippet.publishedAt,
        likeCount: top.snippet.likeCount || 0,
        matchedIn: inComment ? 'comment' : replies.length > 0 ? 'reply' : 'hidden-reply',
        matchingReplies: replies,
        totalReplyCount: thread.snippet.totalReplyCount || 0
      });
    });
    return body.nextPageToken;
  }
  function loop(pageToken) {
    return page(pageToken).then(function (body) {
      var next = collect(body);
      if (next && calls < maxPages) return loop(next);
      return { hits: hits, truncated: !!next, calls: calls };
    });
  }
  return loop(undefined).catch(function (err) {
    if (err && err.reason === 'commentsDisabled') return { hits: [], truncated: false, calls: calls };
    throw err;
  });
}`;

/** The full inline script for the `/search` page. */
export function liveSearchScript(): string {
  return `(function() {
  var liveSearch = (${LIVE_SEARCH_CORE});
  var KEY_STORAGE_KEY = 'ytb_index_operator_key';
  var section = document.getElementById('live-search');
  if (!section) return;
  var key = null;
  try { key = localStorage.getItem(KEY_STORAGE_KEY); } catch (e) {}
  if (!key) return;
  section.hidden = false;
  var button = document.getElementById('live-search-run');
  var status = document.getElementById('live-search-status');
  var list = document.getElementById('live-search-hits');
  var MESSAGES = {
    quotaExceeded: 'Your OperatorKey is out of quota for today. It resets at midnight Pacific Time.',
    dailyLimitExceeded: 'Your OperatorKey is out of quota for today. It resets at midnight Pacific Time.',
    keyInvalid: 'YouTube rejected your OperatorKey. Check it in the operator tools.',
    badRequest: 'YouTube rejected your OperatorKey. Check it in the operator tools.',
    accessNotConfigured: 'Your OperatorKey belongs to a project without the YouTube Data API enabled.',
    ipRefererBlocked: 'Your OperatorKey is restricted and does not allow this site.',
    forbidden: 'Your OperatorKey is restricted and does not allow this search.',
    channelNotFound: 'YouTube does not know this Channel.',
    network: 'Could not reach YouTube. Check your connection and try again.'
  };
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function link(href, text, external) {
    var a = el('a', 'btn btn-text', text);
    a.href = href;
    if (external) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    return a;
  }
  function byline(author, publishedAt) {
    var p = el('p', 'search-hit-byline');
    p.appendChild(el('span', 'author', author));
    var time = el('time', '', String(publishedAt).slice(0, 10));
    time.setAttribute('datetime', publishedAt);
    p.appendChild(time);
    return p;
  }
  function render(hit) {
    var li = el('li', 'search-hit card');
    var meta = el('p', 'search-hit-meta');
    meta.appendChild(el('span', 'search-kind search-kind-live', 'Live'));
    li.appendChild(meta);
    li.appendChild(byline(hit.author, hit.publishedAt));
    li.appendChild(el('p', 'search-hit-snippet', hit.text));
    if (hit.matchingReplies.length > 0) {
      var replies = el('ul', 'live-search-replies');
      hit.matchingReplies.forEach(function (reply) {
        var item = el('li');
        item.appendChild(byline(reply.author, reply.publishedAt));
        item.appendChild(el('p', 'search-hit-snippet', reply.text));
        replies.appendChild(item);
      });
      li.appendChild(replies);
    } else if (hit.matchedIn === 'hidden-reply') {
      li.appendChild(el('p', 'live-search-note',
        'Matched in one of its ' + hit.totalReplyCount + ' Replies, not shown here.'));
    }
    var links = el('p', 'search-hit-links');
    links.appendChild(link('/v/' + encodeURIComponent(hit.videoId) + '#c-' + encodeURIComponent(hit.commentId), 'Open in ytb-index'));
    links.appendChild(link('https://www.youtube.com/watch?v=' + encodeURIComponent(hit.videoId) + '&lc=' + encodeURIComponent(hit.commentId), 'Watch on YouTube', true));
    li.appendChild(links);
    return li;
  }
  button.addEventListener('click', function () {
    button.disabled = true;
    list.textContent = '';
    status.textContent = 'Searching YouTube…';
    liveSearch(window.fetch.bind(window), key, section.dataset.channel, section.dataset.q, ${LIVE_SEARCH_MAX_PAGES})
      .then(function (result) {
        result.hits.forEach(function (hit) { list.appendChild(render(hit)); });
        status.textContent = result.hits.length === 0
          ? 'Nothing on YouTube matches this search.'
          : result.hits.length + (result.hits.length === 1 ? ' thread' : ' threads') +
            (result.truncated ? ' (first results only)' : '') +
            ' from YouTube · ' + result.calls + (result.calls === 1 ? ' unit' : ' units') +
            ' of your quota · not stored';
      }, function (err) {
        status.textContent = MESSAGES[err && err.reason] || 'YouTube search failed.';
      })
      .then(function () { button.disabled = false; });
  });
})();`;
}
