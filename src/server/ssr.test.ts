/**
 * Unit tests for `src/server/ssr.tsx`.
 *
 * The renderers are pure, so these tests assert on raw HTML substrings with
 * hand-built fixtures — no database, no HTTP. The human-readable timestamp
 * footer is checked on the tag-stripped text (its labels are wrapped in links).
 *
 * Run via `pnpm test` (node:test runner, through tsx).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  Channel,
  CommentRecord,
  IngestRequest,
  TimeAnchor,
  VideoRecord,
} from '../shared/types.ts';
import {
  formatCount,
  formatDuration,
  keyMoments,
  renderCatalog,
  renderNotFound,
  renderVideo,
} from './ssr.tsx';

const TODAY = new Date().toISOString();

const CHANNEL: Channel = {
  id: 'UC_test_channel',
  title: 'Test Channel',
  uploadsPlaylistId: 'UU_test_channel',
  fetchedAt: '2026-05-01T09:30:00.000Z',
};

const VIDEO: VideoRecord = {
  id: 'vid1',
  channelId: CHANNEL.id,
  title: 'Hello World',
  description: 'Not rendered',
  publishedAt: TODAY,
  thumbnailUrl: 'https://example.com/vid1.jpg',
  durationIso8601: 'PT5M32S',
  viewCount: 10,
  likeCount: 2,
  commentCount: 1,
  fetchedAt: CHANNEL.fetchedAt,
};

const TIMESTAMPED_COMMENT: CommentRecord = {
  id: 'c1',
  videoId: VIDEO.id,
  channelId: CHANNEL.id,
  author: 'Alice',
  text: 'Check 1:23 and 5:32 and 12:04',
  publishedAt: TODAY,
  likeCount: 4,
  hasAnchors: 1,
  fetchedAt: CHANNEL.fetchedAt,
};

const ANCHORS: TimeAnchor[] = [
  { commentId: 'c1', seconds: 83, rawText: '1:23', charPosition: 6 },
  { commentId: 'c1', seconds: 332, rawText: '5:32', charPosition: 15 },
  { commentId: 'c1', seconds: 724, rawText: '12:04', charPosition: 24 },
];

/** Remove HTML tags so the visible text can be asserted verbatim. */
function visibleText(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

/**
 * Collapse whitespace inside tags. Prettier formats the embedded HTML in
 * `html` tagged templates, so long anchors are emitted across multiple lines;
 * normalizing tags keeps exact-attribute assertions stable.
 */
function normalizeTags(html: string): string {
  return html.replace(/<[^>]*>/g, (tag) => tag.replace(/\s+/g, ' ').replace(/\s+>/g, '>'));
}

describe('renderCatalog', () => {
  it('renders the empty state when there is no channel', () => {
    const out = renderCatalog(null, []);
    assert.ok(out.includes('No channels ingested yet.'));
    assert.ok(out.includes('Paste a channel to ingest'));
  });

  it('renders the channel switcher with all channels', () => {
    const channels = [
      { id: 'UC_other', title: 'Other Channel' },
      { id: CHANNEL.id, title: CHANNEL.title },
    ];
    const out = renderCatalog(CHANNEL, [VIDEO], channels);
    assert.ok(out.includes('Other Channel'));
    assert.ok(out.includes('value="UC_test_channel" selected'));
  });

  it('renders the operator status when provided', () => {
    const status: IngestRequest = {
      id: 'req-1',
      channelInput: '@test',
      channelKey: '@test',
      channelId: CHANNEL.id,
      status: 'running',
      videosWritten: 12,
      commentsWritten: 340,
      error: null,
      createdAt: TODAY,
      updatedAt: TODAY,
      finishedAt: null,
    };
    const out = renderCatalog(CHANNEL, [VIDEO], [], status);
    assert.ok(out.includes('running'));
    assert.ok(out.includes('12 videos / 340 comments'));
  });

  it('renders the v2 counters: Replies, LiveChatMessages, skipped videos, quota (spec v2 stories 22–23)', () => {
    const status: IngestRequest = {
      id: 'req-2',
      channelId: CHANNEL.id,
      status: 'done',
      videosWritten: 12,
      commentsWritten: 340,
      repliesWritten: 25,
      chatMessagesWritten: 410,
      skippedVideos: 3,
      quotaUsed: 1234,
      error: null,
      createdAt: TODAY,
      updatedAt: TODAY,
    };
    const out = renderCatalog(CHANNEL, [VIDEO], [], status);
    assert.ok(
      out.includes(
        '12 videos / 340 comments / 25 replies / 410 chat messages · 3 videos skipped · 1234 quota units',
      ),
    );
  });

  it('renders the OperatorKey field, check/forget buttons and live-chat opt-in (F6 #51)', () => {
    const out = renderCatalog(CHANNEL, [VIDEO]);
    assert.ok(out.includes('id="operator-key"'), 'key field');
    assert.ok(/id="operator-key"[^>]*type="password"/.test(out), 'the key field is masked');
    assert.ok(out.includes('id="operator-key-check"') && out.includes('Check key'));
    assert.ok(out.includes('id="operator-key-forget"') && out.includes('Forget key'));
    assert.ok(out.includes('id="operator-key-verdict"'), 'inline verdict area');
    assert.ok(/id="ingest-capture-live-chat"[^>]*type="checkbox"/.test(out));
    assert.ok(out.includes('Capture live chat'));
    assert.ok(out.includes("'/api/key/check'"), 'the panel script calls the key check');
    for (const match of out.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      assert.doesNotThrow(() => new Function(match[1] ?? ''), 'inline scripts parse');
    }
  });

  it('renders a row with thumbnail, title link, relative date, and summary', () => {
    const out = renderCatalog(CHANNEL, [VIDEO]);
    assert.ok(out.includes('alt="Hello World"'), 'thumbnail alt is the video title');
    assert.ok(out.includes('src="https://example.com/vid1.jpg"'), 'thumbnail src');
    assert.ok(out.includes('href="/v/vid1"'), 'title link');
    assert.ok(out.includes('>today<'), 'relative published date');
    assert.ok(out.includes('1 comments / 0 timestamped'), 'summary line');
  });

  it('shows the "Last refreshed: YYYY-MM-DD" line near the header', () => {
    const out = renderCatalog(CHANNEL, [VIDEO]);
    assert.ok(out.includes('Last refreshed: 2026-05-01'));
  });

  it('counts timestamped comments in the row summary', () => {
    const out = renderCatalog(CHANNEL, [{ ...VIDEO, timestampedCount: 1 }]);
    assert.ok(out.includes('1 comments / 1 timestamped'));
  });

  it('falls back to a generic thumbnail alt when the title is empty', () => {
    const out = renderCatalog(CHANNEL, [{ ...VIDEO, title: '' }]);
    assert.ok(out.includes('alt="Video thumbnail"'));
  });

  it('inlines the stylesheet in a <style> element, not as page text', () => {
    const out = renderCatalog(CHANNEL, [VIDEO]);
    const style = /<style>([\s\S]*?)<\/style>/.exec(out);
    assert.ok(style !== null, 'has a <style> element');
    assert.ok(style[1]?.includes('--md-sys-color-primary'), 'carries the M3 tokens');
    const body = out.slice(out.indexOf('<body>'));
    assert.ok(!body.includes('--md-sys-color'), 'no CSS leaks into the body');
  });

  it('renders the "no videos" empty state for a channel without videos', () => {
    const out = renderCatalog(CHANNEL, []);
    assert.ok(visibleText(out).includes('No videos ingested.'));
    assert.ok(visibleText(out).includes('Run pnpm ingest &lt;channel&gt; to populate.'));
  });

  it('shows the duration badge and the view count on a card', () => {
    const out = renderCatalog(CHANNEL, [{ ...VIDEO, viewCount: 1_234_567 }]);
    assert.ok(out.includes('<span class="duration">5:32</span>'));
    assert.ok(out.includes('1.2M views'));
  });
});

describe('formatDuration', () => {
  it('formats ISO-8601 durations as player timestamps', () => {
    assert.equal(formatDuration('PT5M32S'), '5:32');
    assert.equal(formatDuration('PT45S'), '0:45');
    assert.equal(formatDuration('PT1H2M3S'), '1:02:03');
    assert.equal(formatDuration('P1DT1M'), '24:01:00');
  });

  it('returns an empty string for live streams and unparseable input', () => {
    assert.equal(formatDuration('P0D'), '');
    assert.equal(formatDuration('nonsense'), '');
  });
});

describe('formatCount', () => {
  it('abbreviates counts the way YouTube does', () => {
    assert.equal(formatCount(950), '950');
    assert.equal(formatCount(1_200), '1.2K');
    assert.equal(formatCount(3_400_000), '3.4M');
  });
});

describe('keyMoments', () => {
  it('counts each offset once per comment and keeps the most cited, in playback order', () => {
    const anchors: TimeAnchor[] = [
      { commentId: 'a', seconds: 90, rawText: '1:30', charPosition: 0 },
      { commentId: 'a', seconds: 90, rawText: '1:30', charPosition: 10 },
      { commentId: 'b', seconds: 90, rawText: '1:30', charPosition: 0 },
      { commentId: 'b', seconds: 30, rawText: '0:30', charPosition: 8 },
      { commentId: 'c', seconds: 600, rawText: '10:00', charPosition: 0 },
    ];
    assert.deepEqual(keyMoments(anchors, 2), [
      { seconds: 30, comments: 1 },
      { seconds: 90, comments: 2 },
    ]);
  });
});

describe('renderNotFound', () => {
  it('renders the shared 404 page with the message', () => {
    const out = renderNotFound('Unknown channel.');
    assert.ok(out.includes('404 Not Found'));
    assert.ok(out.includes('Unknown channel.'));
    assert.ok(out.includes('href="/"'));
  });
});

describe('renderVideo', () => {
  it('renders the header, medium thumbnail, and Watch on YouTube button', () => {
    const out = renderVideo(VIDEO, [], []);
    assert.ok(out.includes('<h1>Hello World</h1>'));
    assert.ok(out.includes('<img'), 'medium thumbnail');
    assert.ok(out.includes('>today<'), 'relative published date');
    assert.ok(out.includes('No comments on this video.'));
    assert.ok(
      normalizeTags(out).includes(
        '<a target="_blank" rel="noopener noreferrer" href="https://www.youtube.com/watch?v=vid1">Watch on YouTube</a>',
      ),
      'primary watch link',
    );
  });

  it('renders a TimestampedComment with the accent border and linked footer', () => {
    const out = renderVideo(VIDEO, [TIMESTAMPED_COMMENT], ANCHORS);
    assert.ok(out.includes('class="comment timestamped"'), 'timestamped class');
    assert.ok(
      /\.comment\.timestamped \{[^}]*border-left: 3px solid/.test(out),
      '3px left-border accent',
    );
    assert.ok(
      visibleText(out).includes('Timestamps: 1:23 · 5:32 · 12:04'),
      'footer text with middle-dot separators',
    );
    for (const [seconds, label] of [
      [83, '1:23'],
      [332, '5:32'],
      [724, '12:04'],
    ] as const) {
      assert.ok(
        normalizeTags(out).includes(
          `<a target="_blank" rel="noopener noreferrer" href="https://www.youtube.com/watch?v=vid1&t=${seconds}s">${label}</a>`,
        ),
        `click-jump anchor for ${label}`,
      );
    }
  });

  it('linkifies TimeAnchor substrings inside the comment body', () => {
    const comment: CommentRecord = {
      ...TIMESTAMPED_COMMENT,
      id: 'c-body',
      text: 'jump to 5:32 for the best part',
    };
    const anchors: TimeAnchor[] = [
      { commentId: 'c-body', seconds: 332, rawText: '5:32', charPosition: 8 },
    ];

    const out = renderVideo(VIDEO, [comment], anchors);
    const normalized = normalizeTags(out);
    const link =
      '<a target="_blank" rel="noopener noreferrer" href="https://www.youtube.com/watch?v=vid1&t=332s">5:32</a>';

    assert.ok(normalized.includes(link), 'in-text anchor is a click-jump link');
    assert.ok(
      normalized.includes(`jump to ${link} for the best part`),
      'body text is preserved around the in-text link',
    );
    // Not double-escaped: the timestamp is visible text, not an entity.
    assert.ok(visibleText(out).includes('jump to 5:32 for the best part'));
    assert.ok(!out.includes('&amp;t=332s'), 'href ampersand is not double-escaped');
  });

  it('renders the Key moments panel and the comment filter chips', () => {
    const out = renderVideo(VIDEO, [TIMESTAMPED_COMMENT], ANCHORS);
    assert.ok(out.includes('Key moments'));
    assert.ok(out.includes('id="filter-timestamped"'));
  });

  it('omits the Timestamps footer for a comment without anchors', () => {
    const plain: CommentRecord = {
      ...TIMESTAMPED_COMMENT,
      id: 'c2',
      text: 'no timestamps here',
      hasAnchors: 0,
    };
    const out = renderVideo(VIDEO, [plain], []);
    assert.ok(!out.includes('Timestamps:'));
    assert.ok(out.includes('no timestamps here'));
  });

  it('preserves anchor links on an expired comment placeholder', () => {
    const expired: CommentRecord = {
      ...TIMESTAMPED_COMMENT,
      text: '[Comment text expired — refresh to recover]',
      isExpired: true,
    };
    const out = renderVideo(VIDEO, [expired], ANCHORS);
    assert.ok(out.includes('[Comment text expired — refresh to recover]'));
    assert.ok(out.includes('href="https://www.youtube.com/watch?v=vid1&t=83s"'));
    assert.ok(normalizeTags(out).includes('target="_blank" rel="noopener noreferrer"'));
  });
});
