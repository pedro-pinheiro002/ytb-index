/**
 * Page styles for the SSR UI (`server/styles`).
 *
 * The design system is Material Design 3 (https://m3.material.io), Google's
 * open design system and the one YouTube's own UI descends from. It is applied
 * as plain CSS custom properties named after the M3 token scheme
 * (`--md-sys-color-*`, `--md-sys-typescale-*`, `--md-sys-shape-*`), so there is
 * no runtime dependency and nothing to bundle into the Worker.
 *
 * Colour roles use YouTube's neutral surfaces and its brand red as the primary
 * role, with a light and a dark scheme driven by `prefers-color-scheme`.
 * Timestamp links use YouTube's link blue (tertiary role) so a click-jump reads
 * the same way it does under a YouTube video.
 *
 * Every page shares this one sheet; it is inlined in `<style>` by `ssr.tsx`.
 */

/** M3 system tokens: colour (light + dark), typescale, shape, elevation, motion. */
const TOKENS = `
:root {
  color-scheme: light dark;

  --md-ref-typeface-brand: 'Roboto', system-ui, -apple-system, 'Segoe UI', sans-serif;
  --md-ref-typeface-plain: 'Roboto', system-ui, -apple-system, 'Segoe UI', sans-serif;
  --md-ref-typeface-mono: 'Roboto Mono', ui-monospace, SFMono-Regular, Menlo, monospace;

  --md-sys-color-primary: #cc0029;
  --md-sys-color-on-primary: #ffffff;
  --md-sys-color-primary-container: #ffdad7;
  --md-sys-color-on-primary-container: #410006;
  --md-sys-color-secondary: #0f0f0f;
  --md-sys-color-on-secondary: #ffffff;
  --md-sys-color-secondary-container: #f2f2f2;
  --md-sys-color-on-secondary-container: #0f0f0f;
  --md-sys-color-tertiary: #065fd4;
  --md-sys-color-on-tertiary: #ffffff;
  --md-sys-color-tertiary-container: #def1ff;
  --md-sys-color-on-tertiary-container: #003f8f;
  --md-sys-color-error: #b3261e;
  --md-sys-color-on-error: #ffffff;
  --md-sys-color-error-container: #f9dedc;
  --md-sys-color-on-error-container: #410e0b;
  --md-sys-color-success: #1e7d32;
  --md-sys-color-success-container: #dcf3dd;
  --md-sys-color-on-success-container: #0b3a12;
  --md-sys-color-warning-container: #fff1c2;
  --md-sys-color-on-warning-container: #4a3500;
  --md-sys-color-surface: #ffffff;
  --md-sys-color-surface-dim: #f2f2f2;
  --md-sys-color-surface-container-lowest: #ffffff;
  --md-sys-color-surface-container-low: #f9f9f9;
  --md-sys-color-surface-container: #f2f2f2;
  --md-sys-color-surface-container-high: #e5e5e5;
  --md-sys-color-surface-container-highest: #d9d9d9;
  --md-sys-color-on-surface: #0f0f0f;
  --md-sys-color-on-surface-variant: #606060;
  --md-sys-color-outline: #cccccc;
  --md-sys-color-outline-variant: #e5e5e5;
  --md-sys-color-inverse-surface: #0f0f0f;
  --md-sys-color-inverse-on-surface: #f1f1f1;
  --md-sys-color-scrim: rgb(0 0 0 / 0.6);
  --app-brand: #ff0033;

  --md-sys-typescale-headline-large: 400 2rem/2.5rem var(--md-ref-typeface-brand);
  --md-sys-typescale-headline-small: 700 1.5rem/2rem var(--md-ref-typeface-brand);
  --md-sys-typescale-title-large: 700 1.25rem/1.75rem var(--md-ref-typeface-brand);
  --md-sys-typescale-title-medium: 500 1rem/1.375rem var(--md-ref-typeface-plain);
  --md-sys-typescale-title-small: 500 0.875rem/1.25rem var(--md-ref-typeface-plain);
  --md-sys-typescale-body-large: 400 1rem/1.5rem var(--md-ref-typeface-plain);
  --md-sys-typescale-body-medium: 400 0.875rem/1.25rem var(--md-ref-typeface-plain);
  --md-sys-typescale-body-small: 400 0.75rem/1.125rem var(--md-ref-typeface-plain);
  --md-sys-typescale-label-large: 500 0.875rem/1.25rem var(--md-ref-typeface-plain);
  --md-sys-typescale-label-medium: 500 0.75rem/1rem var(--md-ref-typeface-plain);

  --md-sys-shape-corner-small: 8px;
  --md-sys-shape-corner-medium: 12px;
  --md-sys-shape-corner-large: 16px;
  --md-sys-shape-corner-full: 9999px;

  --md-sys-elevation-level2: 0 1px 2px rgb(0 0 0 / 0.3), 0 2px 6px 2px rgb(0 0 0 / 0.15);
  --md-sys-motion-easing-standard: cubic-bezier(0.2, 0, 0, 1);
  --md-sys-motion-duration-short: 150ms;
  --md-sys-motion-duration-medium: 250ms;

  --md-sys-state-hover-opacity: 0.08;
  --md-sys-state-pressed-opacity: 0.12;
}

@media (prefers-color-scheme: dark) {
  :root {
    --md-sys-color-primary: #ff4e5b;
    --md-sys-color-on-primary: #2d0004;
    --md-sys-color-primary-container: #5c0010;
    --md-sys-color-on-primary-container: #ffdad7;
    --md-sys-color-secondary: #f1f1f1;
    --md-sys-color-on-secondary: #0f0f0f;
    --md-sys-color-secondary-container: #272727;
    --md-sys-color-on-secondary-container: #f1f1f1;
    --md-sys-color-tertiary: #3ea6ff;
    --md-sys-color-on-tertiary: #002a5c;
    --md-sys-color-tertiary-container: #263850;
    --md-sys-color-on-tertiary-container: #cfe6ff;
    --md-sys-color-error: #f2b8b5;
    --md-sys-color-on-error: #601410;
    --md-sys-color-error-container: #8c1d18;
    --md-sys-color-on-error-container: #f9dedc;
    --md-sys-color-success-container: #12391a;
    --md-sys-color-on-success-container: #b9eebd;
    --md-sys-color-warning-container: #3d2e00;
    --md-sys-color-on-warning-container: #ffe08a;
    --md-sys-color-surface: #0f0f0f;
    --md-sys-color-surface-dim: #0f0f0f;
    --md-sys-color-surface-container-lowest: #0a0a0a;
    --md-sys-color-surface-container-low: #181818;
    --md-sys-color-surface-container: #212121;
    --md-sys-color-surface-container-high: #272727;
    --md-sys-color-surface-container-highest: #3f3f3f;
    --md-sys-color-on-surface: #f1f1f1;
    --md-sys-color-on-surface-variant: #aaaaaa;
    --md-sys-color-outline: #3f3f3f;
    --md-sys-color-outline-variant: #303030;
    --md-sys-color-inverse-surface: #f1f1f1;
    --md-sys-color-inverse-on-surface: #0f0f0f;
  }
}
`;

/** Base elements, app shell, and components shared by every page. */
const COMPONENTS = `
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  min-height: 100vh;
  background: var(--md-sys-color-surface);
  color: var(--md-sys-color-on-surface);
  font: var(--md-sys-typescale-body-medium);
  -webkit-font-smoothing: antialiased;
}
a { color: inherit; }
img { max-width: 100%; }
h1, h2, h3, p { margin: 0; }
button, input, select { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--md-sys-color-tertiary); outline-offset: 2px; }
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
.icon { width: 24px; height: 24px; flex: none; fill: currentColor; }
.icon-sm { width: 18px; height: 18px; }

/* Top app bar */
.top-app-bar {
  position: sticky; top: 0; z-index: 10;
  display: flex; align-items: center; gap: 16px;
  height: 56px; padding: 0 16px;
  background: color-mix(in srgb, var(--md-sys-color-surface) 92%, transparent);
  backdrop-filter: blur(12px);
}
.brand {
  display: inline-flex; align-items: center; gap: 4px;
  text-decoration: none; font: 700 1.125rem/1 var(--md-ref-typeface-brand);
  letter-spacing: -0.03em; white-space: nowrap;
}
.brand-mark { width: 30px; height: 21px; }
.brand-mark .bg { fill: var(--app-brand); }
.brand-mark .fg { fill: #fff; }
.search {
  flex: 1; display: flex; justify-content: center; min-width: 0;
}
.search-field {
  display: flex; align-items: center; gap: 8px;
  width: 100%; max-width: 560px; height: 40px; padding: 0 16px;
  border: 1px solid var(--md-sys-color-outline);
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-surface-container-lowest);
  color: var(--md-sys-color-on-surface-variant);
}
.search-field:focus-within { border-color: var(--md-sys-color-tertiary); }
.search-field input {
  flex: 1; min-width: 0; border: 0; outline: 0; background: transparent;
  font: var(--md-sys-typescale-body-large); color: var(--md-sys-color-on-surface);
}
.app-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
.channel-switcher { position: relative; display: flex; align-items: center; }
.channel-switcher select {
  appearance: none; height: 36px; max-width: 220px; padding: 0 36px 0 16px;
  border: 0; border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-secondary-container);
  color: var(--md-sys-color-on-secondary-container);
  font: var(--md-sys-typescale-label-large); cursor: pointer;
  text-overflow: ellipsis;
}
.channel-switcher select:disabled { opacity: 0.6; cursor: default; }
.channel-switcher .icon { position: absolute; right: 10px; pointer-events: none; }

/* Buttons (M3 filled, tonal, outlined, text, icon) */
.btn {
  position: relative; display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  height: 40px; padding: 0 24px; border: 0; border-radius: var(--md-sys-shape-corner-full);
  font: var(--md-sys-typescale-label-large); text-decoration: none; cursor: pointer;
  overflow: hidden; white-space: nowrap;
  transition: background-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}
.btn::after, .icon-btn::after, .chip::after {
  content: ''; position: absolute; inset: 0; border-radius: inherit;
  background: currentColor; opacity: 0; pointer-events: none;
  transition: opacity var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}
.btn:hover::after, .icon-btn:hover::after, .chip:hover::after { opacity: var(--md-sys-state-hover-opacity); }
.btn:active::after, .icon-btn:active::after, .chip:active::after { opacity: var(--md-sys-state-pressed-opacity); }
.btn-filled { background: var(--md-sys-color-secondary); color: var(--md-sys-color-on-secondary); }
.btn-tonal { background: var(--md-sys-color-secondary-container); color: var(--md-sys-color-on-secondary-container); }
.btn-outlined { background: transparent; border: 1px solid var(--md-sys-color-outline); color: var(--md-sys-color-tertiary); }
.btn-text { background: transparent; color: var(--md-sys-color-tertiary); padding: 0 12px; }
.icon-btn {
  position: relative; display: inline-grid; place-items: center;
  width: 40px; height: 40px; padding: 0; border: 0; border-radius: 50%;
  background: transparent; cursor: pointer;
}
.icon-btn[aria-pressed='true'] { background: var(--md-sys-color-secondary-container); }

/* Text fields (M3 outlined) */
.text-field {
  height: 40px; min-width: 0; padding: 0 16px;
  border: 1px solid var(--md-sys-color-outline);
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-surface-container-lowest);
  font: var(--md-sys-typescale-body-large);
}
.text-field:focus { outline: 0; border: 2px solid var(--md-sys-color-tertiary); padding: 0 15px; }

/* Chips (M3 filter / assist) */
.chip {
  position: relative; display: inline-flex; align-items: center; gap: 6px;
  height: 32px; padding: 0 12px; border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-secondary-container);
  color: var(--md-sys-color-on-secondary-container);
  font: var(--md-sys-typescale-label-large); cursor: pointer; user-select: none;
}
.chip-count { color: var(--md-sys-color-on-surface-variant); font-weight: 400; }
.chip-row { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
.chip-row input { position: absolute; opacity: 0; pointer-events: none; }
.chip-row input:checked + .chip {
  background: var(--md-sys-color-secondary); color: var(--md-sys-color-on-secondary);
}
.chip-row input:checked + .chip .chip-count { color: inherit; opacity: 0.8; }
.chip-row input:focus-visible + .chip { outline: 2px solid var(--md-sys-color-tertiary); outline-offset: 2px; }

/* Cards */
.card {
  border-radius: var(--md-sys-shape-corner-large);
  background: var(--md-sys-color-surface-container-low);
  border: 1px solid var(--md-sys-color-outline-variant);
}

/* Snackbar */
.snackbar {
  position: fixed; left: 50%; bottom: 24px; z-index: 20;
  max-width: min(560px, calc(100vw - 32px)); padding: 14px 16px;
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-inverse-surface); color: var(--md-sys-color-inverse-on-surface);
  box-shadow: var(--md-sys-elevation-level2); font: var(--md-sys-typescale-body-medium);
  transform: translate(-50%, 150%); opacity: 0;
  transition: transform var(--md-sys-motion-duration-medium) var(--md-sys-motion-easing-standard),
    opacity var(--md-sys-motion-duration-medium) var(--md-sys-motion-easing-standard);
}
.snackbar.open { transform: translate(-50%, 0); opacity: 1; }

/* Layout */
.page { width: 100%; max-width: 1760px; margin: 0 auto; padding: 8px 24px 64px; }
.empty-state {
  display: grid; justify-items: center; gap: 12px; text-align: center;
  padding: 64px 16px; color: var(--md-sys-color-on-surface-variant);
}
.empty-state .icon { width: 64px; height: 64px; opacity: 0.6; }
.empty-state h2 { font: var(--md-sys-typescale-title-large); color: var(--md-sys-color-on-surface); }
.empty-state code {
  font-family: var(--md-ref-typeface-mono); padding: 2px 6px;
  border-radius: 6px; background: var(--md-sys-color-surface-container);
}

/* Avatars */
.avatar {
  display: inline-grid; place-items: center; flex: none;
  width: 40px; height: 40px; border-radius: 50%;
  background: hsl(var(--avatar-hue, 0) 55% 42%); color: #fff;
  font: 500 1.125rem/1 var(--md-ref-typeface-plain); text-transform: uppercase;
}
.avatar-lg { width: 80px; height: 80px; font-size: 2.25rem; }

/* Operator tools */
.operator-section { margin: 0 0 24px; }
.operator-only { display: none; }
.is-operator .visitor-only { display: none; }
.operator-card { padding: 16px 20px; display: grid; gap: 12px; }
.operator-card h2 { font: var(--md-sys-typescale-title-medium); display: flex; align-items: center; gap: 8px; }
.operator-card .hint { color: var(--md-sys-color-on-surface-variant); }
.inline-form { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.inline-form .text-field { flex: 1 1 280px; }
.shape-error { color: var(--md-sys-color-error); font: var(--md-sys-typescale-body-small); display: none; }
.operator-footer { display: flex; justify-content: flex-end; }
.operator-key { display: grid; gap: 8px; }
.operator-key label, .checkbox-row { font: var(--md-sys-typescale-body-medium); color: var(--md-sys-color-on-surface-variant); }
.checkbox-row { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; }
.key-verdict { font: var(--md-sys-typescale-body-small); min-height: 1em; margin: 0; }
.key-verdict.is-ok { color: var(--md-sys-color-primary); }
.key-verdict.is-error { color: var(--md-sys-color-error); }
.status {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px;
  color: var(--md-sys-color-on-surface-variant);
}
.status-badge {
  display: inline-flex; align-items: center; height: 24px; padding: 0 10px;
  border-radius: var(--md-sys-shape-corner-full);
  font: var(--md-sys-typescale-label-medium); text-transform: uppercase; letter-spacing: 0.04em;
  background: var(--md-sys-color-surface-container-high); color: var(--md-sys-color-on-surface);
}
.status-queued, .status-running { background: var(--md-sys-color-warning-container); color: var(--md-sys-color-on-warning-container); }
.status-done { background: var(--md-sys-color-success-container); color: var(--md-sys-color-on-success-container); }
.status-failed { background: var(--md-sys-color-error-container); color: var(--md-sys-color-on-error-container); }
.progress {
  flex-basis: 100%; height: 4px; border-radius: 2px; overflow: hidden;
  background: var(--md-sys-color-surface-container-high);
}
.progress::before {
  content: ''; display: block; width: 40%; height: 100%; border-radius: inherit;
  background: var(--md-sys-color-primary); animation: progress 1.4s var(--md-sys-motion-easing-standard) infinite;
}
@keyframes progress { from { transform: translateX(-100%); } to { transform: translateX(250%); } }
.ingest-error {
  flex-basis: 100%; white-space: pre-wrap; padding: 8px 12px;
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-error-container); color: var(--md-sys-color-on-error-container);
}
.hero { display: grid; gap: 12px; justify-items: center; text-align: center; padding: 32px 8px; }
.hero h2 { font: var(--md-sys-typescale-headline-small); }
.hero .inline-form { width: 100%; max-width: 640px; justify-content: center; }

/* Channel header */
.channel-header { display: flex; align-items: center; gap: 24px; padding: 16px 0 24px; }
.channel-header h1 { font: var(--md-sys-typescale-headline-small); font-size: clamp(1.5rem, 3vw, 2.25rem); line-height: 1.2; }
.channel-stats { display: flex; flex-wrap: wrap; gap: 4px 0; margin-top: 6px; color: var(--md-sys-color-on-surface-variant); }
.channel-stats > * + *::before { content: '•'; margin: 0 6px; }
.last-refreshed { color: var(--md-sys-color-on-surface-variant); }
.section-tabs {
  display: flex; gap: 24px; margin-bottom: 24px;
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
}
.section-tabs span {
  padding: 12px 0; font: var(--md-sys-typescale-title-small);
  border-bottom: 2px solid var(--md-sys-color-on-surface);
}

/* Video grid */
.catalog {
  list-style: none; margin: 0; padding: 0;
  display: grid; gap: 40px 16px; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
}
.video-card { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.video-card[hidden] { display: none; }
.thumbnail {
  position: relative; display: block; aspect-ratio: 16 / 9; overflow: hidden;
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-surface-container-high);
}
.thumbnail img {
  display: block; width: 100%; height: 100%; object-fit: cover;
  transition: transform var(--md-sys-motion-duration-medium) var(--md-sys-motion-easing-standard);
}
.video-card:hover .thumbnail img { transform: scale(1.03); }
.duration {
  position: absolute; right: 8px; bottom: 8px; padding: 1px 4px; border-radius: 4px;
  background: rgb(0 0 0 / 0.8); color: #fff; font: var(--md-sys-typescale-label-medium);
}
.ts-badge {
  position: absolute; left: 8px; bottom: 8px; display: inline-flex; align-items: center; gap: 2px;
  padding: 1px 6px 1px 4px; border-radius: 4px;
  background: var(--app-brand); color: #fff; font: var(--md-sys-typescale-label-medium);
}
.video-meta { display: flex; flex-direction: column; gap: 4px; min-width: 0; padding-right: 8px; }
.video-title {
  font: var(--md-sys-typescale-title-medium); text-decoration: none;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.video-byline { color: var(--md-sys-color-on-surface-variant); }
.video-byline > * + *::before { content: '•'; margin: 0 4px; }
.video-summary { color: var(--md-sys-color-on-surface-variant); display: flex; align-items: center; gap: 4px; }
.no-results { padding: 48px 0; text-align: center; color: var(--md-sys-color-on-surface-variant); }

/* Video detail */
.watch { display: grid; gap: 24px; grid-template-columns: minmax(0, 1fr) 400px; align-items: start; }
.player {
  position: relative; display: block; aspect-ratio: 16 / 9; overflow: hidden;
  border-radius: var(--md-sys-shape-corner-medium); background: #000;
}
.player img { display: block; width: 100%; height: 100%; object-fit: cover; opacity: 0.85; }
.player .play {
  position: absolute; inset: 0; margin: auto; width: 68px; height: 48px;
  transition: transform var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}
.player:hover .play { transform: scale(1.1); }
.play .bg { fill: rgb(33 33 33 / 0.8); }
.player:hover .play .bg { fill: var(--app-brand); }
.play .fg { fill: #fff; }
.video-header { display: grid; gap: 12px; padding-top: 12px; }
.video-header h1 { font: var(--md-sys-typescale-title-large); }
.video-header .published { color: var(--md-sys-color-on-surface-variant); display: flex; flex-wrap: wrap; gap: 4px 0; }
.video-header .published > * + *::before { content: '•'; margin: 0 6px; }
.watch-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.watch-actions > a:not(.btn) {
  display: inline-flex; align-items: center; gap: 8px; height: 40px; padding: 0 20px 0 16px;
  border-radius: var(--md-sys-shape-corner-full); text-decoration: none;
  background: var(--md-sys-color-primary); color: var(--md-sys-color-on-primary);
  font: var(--md-sys-typescale-label-large);
}
.watch-actions > a:not(.btn):hover { filter: brightness(1.08); }
.back-link { display: inline-flex; align-items: center; gap: 4px; }

.comments-section { display: grid; gap: 16px; margin-top: 24px; }
.comments-section h2 { font: var(--md-sys-typescale-title-large); }
.comments { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.comments-section:has(#filter-timestamped:checked) .comment:not(.timestamped):not(.has-timestamped-reply) { display: none; }
.comment {
  display: flex; gap: 16px; padding: 12px 12px 12px 15px;
  border-left: 3px solid transparent; border-radius: 0 var(--md-sys-shape-corner-medium) var(--md-sys-shape-corner-medium) 0;
}
.comment.timestamped { border-left: 3px solid var(--app-brand); background: var(--md-sys-color-surface-container-low); }
.comment-content { display: grid; gap: 4px; min-width: 0; }
.comment-meta { font: var(--md-sys-typescale-label-medium); color: var(--md-sys-color-on-surface-variant); }
.comment-meta .author { color: var(--md-sys-color-on-surface); font-weight: 500; margin-right: 4px; }
.comment-body { font: var(--md-sys-typescale-body-medium); white-space: pre-wrap; overflow-wrap: anywhere; }
.comment.expired .comment-body { font-style: italic; color: var(--md-sys-color-on-surface-variant); }
.comment-body a, .timestamps a, .moment-time {
  color: var(--md-sys-color-tertiary); text-decoration: none; font-weight: 500;
  font-variant-numeric: tabular-nums;
}
.comment-body a:hover, .timestamps a:hover { text-decoration: underline; }
.comment-actions {
  display: flex; align-items: center; gap: 4px; margin-top: 4px;
  color: var(--md-sys-color-on-surface-variant); font: var(--md-sys-typescale-body-small);
}
.timestamps { font: var(--md-sys-typescale-body-small); color: var(--md-sys-color-on-surface-variant); margin-top: 4px; }
.timestamps a {
  display: inline-block; padding: 2px 8px; border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-tertiary-container); color: var(--md-sys-color-on-tertiary-container);
  font: var(--md-sys-typescale-label-medium);
}
.timestamps a:hover { text-decoration: none; filter: brightness(0.95); }

.moments { position: sticky; top: 72px; padding: 16px; display: grid; gap: 12px; }
.moments h2 { font: var(--md-sys-typescale-title-medium); display: flex; align-items: center; gap: 8px; }
.moments .hint { color: var(--md-sys-color-on-surface-variant); font: var(--md-sys-typescale-body-small); }
.moment-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; max-height: 60vh; overflow: auto; }
.moment-list a {
  position: relative; display: grid; grid-template-columns: 72px 1fr auto; align-items: center; gap: 12px;
  padding: 8px 12px; border-radius: var(--md-sys-shape-corner-small); text-decoration: none;
}
.moment-list a:hover { background: var(--md-sys-color-surface-container-high); }
.moment-bar { height: 6px; border-radius: 3px; background: var(--md-sys-color-surface-container-highest); overflow: hidden; }
.moment-bar span { display: block; height: 100%; background: var(--app-brand); border-radius: inherit; }
.moment-count { color: var(--md-sys-color-on-surface-variant); font: var(--md-sys-typescale-label-medium); }

.not-found { display: grid; justify-items: center; gap: 16px; padding: 96px 16px; text-align: center; }
.not-found h1 { font: var(--md-sys-typescale-headline-large); }
.not-found p { color: var(--md-sys-color-on-surface-variant); }

/* Search page (F5 #53): GET form, SearchHit cards, pagination */
.search-page { display: grid; gap: 16px; max-width: 960px; margin: 16px auto 0; }
.search-page h1 { font: var(--md-sys-typescale-headline-small); }
.search-form { display: grid; gap: 16px; padding: 16px 20px; }
.search-row { display: flex; gap: 8px; }
.search-row .text-field { flex: 1 1 auto; }
.search-form fieldset { border: 0; margin: 0; padding: 0; }
.search-filters { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }
.search-filter { display: grid; gap: 4px; font: var(--md-sys-typescale-label-medium); color: var(--md-sys-color-on-surface-variant); }
.search-filter .text-field { width: 100%; font: var(--md-sys-typescale-body-medium); color: var(--md-sys-color-on-surface); }
.search-errors {
  padding: 16px 20px; border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-error-container); color: var(--md-sys-color-on-error-container);
}
.search-errors h2 { font: var(--md-sys-typescale-title-medium); margin-bottom: 4px; }
.search-errors ul { margin: 0; padding-left: 20px; font: var(--md-sys-typescale-body-medium); }
.search-hits { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
.search-hit { padding: 12px 16px; display: grid; gap: 4px; }
.search-hit-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.search-kind {
  padding: 2px 8px; border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-secondary-container); color: var(--md-sys-color-on-secondary-container);
  font: var(--md-sys-typescale-label-medium);
}
.search-kind-chat { background: var(--md-sys-color-primary-container); color: var(--md-sys-color-on-primary-container); }
.search-kind-video { background: var(--md-sys-color-tertiary-container); color: var(--md-sys-color-on-tertiary-container); }
.search-hit-video { font: var(--md-sys-typescale-title-small); color: var(--md-sys-color-on-surface); text-decoration: none; }
.search-hit-video:hover { text-decoration: underline; }
.search-hit-byline {
  display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px;
  font: var(--md-sys-typescale-body-small); color: var(--md-sys-color-on-surface-variant);
}
.search-hit-byline .author { color: var(--md-sys-color-on-surface); font-weight: 500; }
.search-hit-likes { display: inline-flex; align-items: center; gap: 4px; }
.search-hit-snippet { font: var(--md-sys-typescale-body-medium); white-space: pre-wrap; overflow-wrap: anywhere; }
.search-hit-snippet mark {
  background: var(--md-sys-color-warning-container); color: var(--md-sys-color-on-warning-container);
  border-radius: 2px; padding: 0 1px;
}
.search-hit-links { display: flex; flex-wrap: wrap; gap: 4px; margin-left: -12px; }
.search-pagination { display: flex; align-items: center; justify-content: center; gap: 16px; padding: 8px 0; }

/* Video page v2: Broadcast line, nested Replies, Live chat panel (F7 #54) */
.broadcast-line {
  display: flex; flex-wrap: wrap; align-items: center; gap: 4px 0;
  color: var(--md-sys-color-on-surface-variant); font: var(--md-sys-typescale-body-medium);
}
.broadcast-line > * + *::before { content: '•'; margin: 0 6px; }
.broadcast-badge {
  display: inline-block; padding: 2px 8px; border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-secondary-container); color: var(--md-sys-color-on-secondary-container);
  font: var(--md-sys-typescale-label-medium); text-transform: uppercase; letter-spacing: 0.04em;
}
.broadcast-badge.broadcast-live { background: var(--app-brand); color: var(--md-sys-color-on-primary); }
.replies { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 4px; }
.comment.reply { padding: 8px 8px 8px 11px; }
.comment.has-timestamped-reply:not(.timestamped) > .comment-content > .comment-body { color: var(--md-sys-color-on-surface-variant); }
.watch-side { position: sticky; top: 72px; display: grid; gap: 16px; align-content: start; }
.watch-side .moments { position: static; }
.chat-panel { padding: 16px; display: grid; gap: 12px; }
.chat-panel h2 { font: var(--md-sys-typescale-title-medium); display: flex; align-items: center; gap: 8px; }
.chat-panel .hint { color: var(--md-sys-color-on-surface-variant); font: var(--md-sys-typescale-body-small); }
.chat-empty { font: var(--md-sys-typescale-title-small); }
.chat-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; max-height: 60vh; overflow: auto; }
.chat-message { display: flex; gap: 8px; align-items: baseline; padding: 4px 8px; border-radius: var(--md-sys-shape-corner-small); }
.chat-message:target { background: var(--md-sys-color-warning-container); color: var(--md-sys-color-on-warning-container); }
.comment:target { background: var(--md-sys-color-warning-container); }
.chat-time {
  flex: none; color: var(--md-sys-color-tertiary); text-decoration: none; font: var(--md-sys-typescale-label-medium);
  font-variant-numeric: tabular-nums;
}
.chat-time:hover { text-decoration: underline; }
.chat-content { font: var(--md-sys-typescale-body-medium); overflow-wrap: anywhere; min-width: 0; }
.chat-content .author { color: var(--md-sys-color-on-surface-variant); font-weight: 500; margin-right: 4px; }
.chat-message.expired .chat-text { font-style: italic; color: var(--md-sys-color-on-surface-variant); }

@media (max-width: 1100px) {
  .watch { grid-template-columns: minmax(0, 1fr); }
  .moments { position: static; }
  .watch-side { position: static; }
}
@media (max-width: 720px) {
  .page { padding: 0 16px 48px; }
  .top-app-bar { gap: 8px; padding: 0 12px; }
  .brand-text { display: none; }
  .search-field { padding: 0 12px; }
  .channel-switcher select { max-width: 120px; padding-left: 12px; }
  .catalog { grid-template-columns: minmax(0, 1fr); gap: 24px; }
  .page > .catalog .thumbnail { margin: 0 -16px; border-radius: 0; }
  .channel-header { gap: 16px; }
  .avatar-lg { width: 64px; height: 64px; font-size: 1.75rem; }
  .watch .player { margin: 0 -16px; border-radius: 0; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition: none !important; animation: none !important; }
}
`;

/** The complete stylesheet, ready to be inlined in a `<style>` element. */
export const STYLES: string = TOKENS + COMPONENTS;
