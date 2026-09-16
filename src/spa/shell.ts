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
body{margin:0;min-height:100vh;min-height:100dvh}
#app{min-height:60vh}
[hidden]{display:none!important}
.mobile-search-toggle,.tab-bar,.more-sheet,.sheet-scrim{display:none}
@media (max-width:719px){
body{padding-bottom:calc(66px + env(safe-area-inset-bottom,0px))}
.site-header-inner{flex-wrap:nowrap;gap:.6rem;padding:.55rem 1rem}
.main-nav{display:none}
.mobile-search-toggle{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;margin-left:auto;padding:0;color:#5f594c;background:transparent;border:0;border-radius:999px}
.mobile-search-toggle svg{width:1.25rem;height:1.25rem}
.header-actions{margin-left:0;gap:.35rem}
.site-header .theme-toggle,.site-header .avatar-btn{width:44px;height:44px}
.header-search{display:none}
.site-header.search-open .site-header-inner{flex-wrap:wrap}
.site-header.search-open .header-search{display:flex;flex:1 1 100%}
.site-header.search-open .header-search input[type="search"]{flex:1;width:auto;height:44px;font-size:16px}
.tab-bar{display:flex;position:fixed;left:0;right:0;bottom:0;z-index:60;background:rgba(250,249,246,.88);border-top:1px solid #e5dfd0;padding-bottom:env(safe-area-inset-bottom,0px)}
html[data-theme="dark"] .tab-bar{background:rgba(11,12,16,.82);border-top-color:#262b38}
.tab-link{flex:1 1 0;min-width:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;min-height:58px;padding:.4rem .15rem;border:0;background:transparent;cursor:pointer;font-family:system-ui,sans-serif;font-size:.66rem;font-weight:600;color:#5f594c}
html[data-theme="dark"] .tab-link{color:#a9b1c2}
.tab-pill{display:inline-flex;align-items:center;justify-content:center;padding:.28rem .85rem;border-radius:999px}
.tab-pill svg{width:1.3rem;height:1.3rem}
.tab-link.active{color:#1e1c17}
html[data-theme="dark"] .tab-link.active{color:#f1f2f5}
.tab-link.active .tab-pill{background:#f4f1ea}
html[data-theme="dark"] .tab-link.active .tab-pill{background:#171a23}
.tab-label{white-space:nowrap;line-height:1.2}
.more-sheet{display:block;position:fixed;left:0;right:0;bottom:0;z-index:71;max-height:calc(90svh - env(safe-area-inset-bottom,0px));overflow-y:auto;background:#fff;border-top:1px solid #e5dfd0;border-radius:16px 16px 0 0;padding:.4rem .75rem calc(.9rem + env(safe-area-inset-bottom,0px))}
html[data-theme="dark"] .more-sheet{background:#12141b;border-top-color:#262b38}
.sheet-scrim{display:block;position:fixed;inset:0;z-index:70;background:rgba(20,16,10,.45)}
html[data-theme="dark"] .sheet-scrim{background:rgba(0,0,0,.6)}
.sheet-item{display:flex;align-items:center;gap:.8rem;width:100%;min-height:48px;padding:.55rem .9rem;border:0;border-radius:10px;background:transparent;color:#1e1c17;font-family:system-ui,sans-serif;font-size:.95rem;font-weight:600;text-align:left}
html[data-theme="dark"] .sheet-item{color:#f1f2f5}
}
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
