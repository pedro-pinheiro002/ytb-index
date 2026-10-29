/**
 * Link and fragment helpers shared by the video page and the `/search` page
 * (`server/links`), extracted for F7 (#54) from `./search-page.tsx` (F5 #53).
 *
 * Spec v2 "SearchHit links": a SearchHit points at `/v/{videoId}` plus
 * `#c-{commentId}` or `#m-{messageId}`, so the video page gives every
 * CommentRecord and LiveChatMessage element the matching `id`. The ids built
 * here are raw strings: callers interpolate them through Hono's `html`
 * helper, which escapes them as attribute values, and percent-encode them
 * when they go into a URL fragment.
 */

/** YouTube's watch URL, without the video id. */
export const WATCH_URL = 'https://www.youtube.com/watch?v=';

/** The element id of a CommentRecord (top-level or Reply) on the video page. */
export function commentElementId(commentId: string): string {
  return `c-${commentId}`;
}

/** The element id of a LiveChatMessage on the video page. */
export function chatElementId(messageId: string): string {
  return `m-${messageId}`;
}
