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
import type { Channel, CommentRecord, TimeAnchor, VideoRecord } from '../shared/types.ts';
import { renderCatalog, renderVideo } from './ssr.tsx';

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
    assert.ok(out.includes('No videos ingested. Run pnpm ingest <channel> to populate.'));
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
    assert.ok(out.includes('border-left: 3px solid'), '3px left-border accent');
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
