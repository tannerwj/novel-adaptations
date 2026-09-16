// src/spa/shell.ts — the SPA shell: a single HTML document served for every
// bookmarkable page route. The client router (public/app.js) takes over from
// here; all data flows through /api/v1. No HTML is generated per-page, so
// there is nothing to keep in sync with the API contract.

export type ThemeName = 'light' | 'dark';

const LIGHT_BG = '#faf9f6';
const DARK_BG = '#0b0c10';

/** Minimal above-the-fold CSS so first paint isn't blank before /styles.css lands.
 * The boot spinner is a fixed overlay (out of document flow): it looks
 * exactly the same centered spinner, but removing it never shifts page
 * content, so the SPA boot costs no Cumulative Layout Shift. */
const CRITICAL_CSS = `
html{background:${LIGHT_BG}}
html[data-theme="dark"]{background:${DARK_BG}}
body{margin:0;min-height:100vh}
#app{min-height:60vh}
.boot{position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;gap:.75rem;color:#8a8578;font-family:system-ui,sans-serif;background:transparent}
html[data-theme="dark"] .boot{color:#8b93a3}
.boot .spinner{width:22px;height:22px;border-radius:50%;border:3px solid currentColor;border-top-color:transparent;animation:bootspin .8s linear infinite}
@keyframes bootspin{to{transform:rotate(360deg)}}
`.trim();

/**
 * Pre-paint theme script (runs synchronously in <head>, before any CSS):
 * mirrors the `theme` cookie onto <html data-theme> so the correct palette
 * paints on the very first frame — no light/dark flash.
 */
const THEME_SCRIPT = `(function(){try{var m=document.cookie.match(/(?:^|;\\s*)theme=(light|dark)/);document.documentElement.setAttribute('data-theme',m?m[1]:'light')}catch(e){document.documentElement.setAttribute('data-theme','light')}})();`;

/**
 * Phase 4 (observability): Cloudflare Web Analytics (RUM) beacon. The
 * site_tag is a PUBLIC identifier (it ships in every page source) — not a
 * secret. Created via the Cloudflare API on 2026-09-15 for
 * noveladaptations.com. Privacy-friendly: no cookies, no fingerprinting.
 */
const WEB_ANALYTICS_TOKEN = '09461fe85155427cb0bcb85a04cb9385';

const WEB_ANALYTICS_BEACON =
  `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" ` +
  `data-cf-beacon='{"token": "${WEB_ANALYTICS_TOKEN}"}'></script>`;

export function spaShell(
  theme: ThemeName,
  headerHtml = '',
  footerHtml = '',
  bootUserJson = 'null',
) {
  const themeColor = theme === 'dark' ? DARK_BG : LIGHT_BG;
  return (
    `<!DOCTYPE html>` +
    `<html lang="en" data-theme="${theme}">` +
    `<head>` +
    `<meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>Novel Adaptations</title>` +
    `<meta name="description" content="Track every book's journey to the screen — rumored adaptations, release dates, ratings, polls, and shareable lists.">` +
    `<meta name="theme-color" content="${themeColor}">` +
    `<meta property="og:site_name" content="Novel Adaptations">` +
    `<meta property="og:title" content="Novel Adaptations">` +
    `<meta property="og:description" content="Every book's journey to the screen — from whispered rumors to opening night.">` +
    `<meta property="og:type" content="website">` +
    `<link rel="icon" type="image/png" href="/favicon.png">` +
    `<link rel="apple-touch-icon" href="/apple-touch-icon.png">` +
    `<script>${THEME_SCRIPT}</script>` +
    `<style>${CRITICAL_CSS}</style>` +
    // Preconnect to the poster/cover image hosts: the LCP element on every
    // baseline page is a poster image whose URL is only known after the view
    // API responds, so an early connection shaves the TLS+TCP handshake off
    // the critical image request. No visual change.
    `<link rel="preconnect" href="https://covers.openlibrary.org">` +
    `<link rel="preconnect" href="https://image.tmdb.org">` +
    `<link rel="stylesheet" href="/styles.css">` +
    `</head>` +
    `<body>` +
    `<div id="chrome-header">${headerHtml}</div>` +
    `<main id="app"><div class="boot" role="status" aria-live="polite"><span class="spinner" aria-hidden="true"></span><span>Loading…</span></div></main>` +
    `<div id="chrome-footer">${footerHtml}</div>` +
    `<noscript><p style="text-align:center;font-family:system-ui,sans-serif;padding:2rem">Novel Adaptations needs JavaScript to run.</p></noscript>` +
    // Boot user, resolved server-side for the header render. The client
    // picks this up (public/js/store.js) and skips its /api/v1/auth/me round
    // trip on first paint — same {id, email, is_admin} shape as that API.
    // `<` is unicode-escaped so an email address can never break out of the
    // script tag.
    `<script>window.__naUser=${bootUserJson};</script>` +
    `<script type="module" src="/app.js"></script>` +
    `${WEB_ANALYTICS_BEACON}` +
    `</body>` +
    `</html>`
  );
}
