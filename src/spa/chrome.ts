// src/spa/chrome.ts — server-rendered header/footer for the SPA shell.
//
// WHY THIS EXISTS: the client used to inject the header/footer into the DOM
// after boot (mountChrome), which shifted every page down by the header
// height — the single largest Cumulative Layout Shift source on the site
// (Lighthouse cls-culprits-insight). Rendering the chrome in the initial
// HTML removes that shift entirely.
//
// CONTRACT: serverHeaderHtml()/serverFooterHtml() must stay byte-identical
// to public/js/components.js headerHtml()/footerHtml() for the same inputs
// (pathname, theme, logged-out user). The client still calls refreshChrome()
// on every navigation; when the HTML matches, innerHTML replacement is a
// no-op and nothing moves. If you change one, change the other.

import type { ThemeName } from './shell';

export interface ChromeUser {
  email: string;
  isAdmin: boolean;
}

const NAV_LINKS: Array<[string, string]> = [
  ['/', 'Home'],
  ['/calendar', 'Calendar'],
  ['/most-wanted', 'Most Wanted'],
  ['/lists', 'Lists'],
  ['/shelves', 'Shelves'],
];

const SUN_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`;
const MOON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>`;
const SEARCH_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>`;
const HOME_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>`;
const CAL_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>`;
const STAR_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l2.7 5.8 6.3.7-4.7 4.3 1.3 6.2L12 16.9 6.4 20l1.3-6.2L3 9.5l6.3-.7z"/></svg>`;
const DOTS_SVG = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>`;

/** Mirror of public/js/utils.js esc(). */
function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Mirror of public/js/utils.js initialsFor(). */
function initialsFor(email: string): string {
  const local = (String(email ?? '').split('@')[0] ?? '').trim();
  const parts = local.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  const initials =
    parts.length >= 2
      ? parts.slice(0, 2).map((p) => p[0] ?? '').join('')
      : (parts[0] ?? local).slice(0, 2);
  return (initials || 'N').toUpperCase().slice(0, 2);
}

/** Which bottom-tab is active for a pathname; detail pages → no tab.
 *  Mirror of mobileTabFor() in public/js/components.js. */
function mobileTabFor(pathname: string): 'home' | 'calendar' | 'most-wanted' | 'search' | null {
  if (pathname === '/') return 'home';
  if (pathname === '/calendar' || pathname.startsWith('/calendar/')) return 'calendar';
  if (pathname === '/most-wanted' || pathname.startsWith('/most-wanted/')) return 'most-wanted';
  if (pathname === '/search' || pathname.startsWith('/search/')) return 'search';
  return null;
}

/** Which More-sheet item is active; null when the sheet has no match.
 *  Mirror of moreItemFor() in public/js/components.js. */
function moreItemFor(path: string): string | null {
  const q = path.indexOf('?');
  const pathname = q === -1 ? path : path.slice(0, q);
  const search = q === -1 ? '' : path.slice(q);
  if (pathname === '/admin/news' || pathname.startsWith('/admin/news/')) return 'admin-news';
  if (pathname === '/admin/screen-works' || pathname.startsWith('/admin/screen-works/')) return 'admin-screen-works';
  if (pathname === '/admin/feedback' || pathname.startsWith('/admin/feedback/')) return 'admin-feedback';
  if (pathname === '/lists' || pathname.startsWith('/lists/')) return 'lists';
  if (pathname === '/shelves' || pathname.startsWith('/shelves/')) return 'shelves';
  if (pathname === '/feedback' || pathname.startsWith('/feedback/')) {
    if (search.includes('type=correction')) return 'feedback-correction';
    if (search.includes('type=adaptation_tip')) return 'feedback-adaptation_tip';
    return 'feedback-feature';
  }
  return null;
}

/**
 * Mobile chrome (≤719px): bottom tab bar + More bottom sheet.
 * Byte-identical mirror of mobileChromeHtml() in public/js/components.js —
 * if you change one, change the other.
 */
function mobileChromeHtml(pathname: string, theme: ThemeName, user: ChromeUser | null, search = ''): string {
  const tab = mobileTabFor(pathname);
  const moreItem = moreItemFor(pathname + search);
  const tabLink = (id: string, href: string, label: string, icon: string): string => {
    const active = tab === id;
    return `<a class="tab-link${active ? ' active' : ''}" href="${href}"${active ? ' aria-current="page"' : ''}>` +
      `<span class="tab-pill" aria-hidden="true">${icon}</span><span class="tab-label">${label}</span></a>`;
  };
  const sheetItem = (id: string, href: string, icon: string, label: string): string =>
    `<a class="sheet-item${moreItem === id ? ' active' : ''}" href="${href}">` +
      `<span class="sheet-ico" aria-hidden="true">${icon}</span>${label}</a>`;
  const themeLabel = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  return (
    `<nav class="tab-bar" aria-label="Primary">` +
      tabLink('home', '/', 'Home', HOME_SVG) +
      tabLink('calendar', '/calendar', 'Calendar', CAL_SVG) +
      tabLink('most-wanted', '/most-wanted', 'Most Wanted', STAR_SVG) +
      tabLink('search', '/search', 'Search', SEARCH_SVG) +
      `<button class="tab-link${moreItem ? ' active' : ''}" type="button" data-more-btn aria-expanded="false" aria-controls="more-sheet">` +
        `<span class="tab-pill" aria-hidden="true">${DOTS_SVG}</span><span class="tab-label">More</span></button>` +
    `</nav>` +
    `<div class="sheet-scrim" data-more-scrim hidden></div>` +
    `<section class="more-sheet" id="more-sheet" data-more-sheet hidden role="dialog" aria-modal="true" aria-label="More">` +
      `<div class="sheet-handle" aria-hidden="true"></div>` +
      `<nav aria-label="More destinations">` +
        sheetItem('lists', '/lists', '🗂️', 'Lists') +
        sheetItem('shelves', '/shelves', '📚', 'Shelves') +
        sheetItem('feedback-feature', '/feedback?type=feature', '💡', 'Suggest a feature') +
        sheetItem('feedback-adaptation_tip', '/feedback?type=adaptation_tip', '🎬', 'Report an adaptation') +
        sheetItem('feedback-correction', '/feedback?type=correction', '✏️', 'Suggest a correction') +
        `<button class="sheet-item theme-toggle" type="button" data-theme-toggle aria-label="${themeLabel}" title="${themeLabel}">` +
          `<span class="sheet-ico" aria-hidden="true">` +
            `<span data-theme-icon="sun"${theme !== 'dark' ? ' hidden' : ''}>☀️</span>` +
            `<span data-theme-icon="moon"${theme === 'dark' ? ' hidden' : ''}>🌙</span>` +
          `</span>Theme</button>` +
        (user && user.isAdmin
          ? `<hr class="sheet-divider">` +
            `<p class="sheet-cap">Admin</p>` +
            sheetItem('admin-news', '/admin/news', '📰', 'News curation') +
            sheetItem('admin-feedback', '/admin/feedback', '💬', 'Feedback triage') +
            sheetItem('admin-screen-works', '/admin/screen-works', '🎬', 'Screen works')
          : '') +
        `<hr class="sheet-divider">` +
        (user
          ? `<button class="sheet-item" type="button" data-logout><span class="sheet-ico" aria-hidden="true">⎋</span>Log out</button>`
          : `<a class="sheet-item" href="/auth/login"><span class="sheet-ico" aria-hidden="true">🔑</span>Log in</a>`) +
      `</nav>` +
    `</section>`
  );
}

export function serverHeaderHtml(pathname: string, theme: ThemeName, user: ChromeUser | null, search = ''): string {
  const nav = NAV_LINKS.map(([href, label]) => {
    const active = href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(href + '/');
    return `<a class="nav-link${active ? ' active' : ''}" href="${href}">${label}</a>`;
  }).join('');
  const userArea = user
    ? `<div class="user-menu">` +
        `<button class="avatar-btn" type="button" data-user-menu-btn aria-haspopup="menu" aria-expanded="false" aria-controls="account-menu" title="${esc(user.email)}">${esc(initialsFor(user.email))}</button>` +
        `<div class="menu" id="account-menu" role="menu" data-user-menu hidden>` +
          `<a class="menu-item" role="menuitem" href="/shelves">Shelves</a>` +
          `<a class="menu-item" role="menuitem" href="/lists">My Lists</a>` +
          `<a class="menu-item" role="menuitem" href="/feedback">Feedback</a>` +
          `<hr class="menu-divider">` +
          (user.isAdmin
            ? `<p class="menu-label">Admin</p>` +
              `<a class="menu-item" role="menuitem" href="/admin/news">News curation</a>` +
              `<a class="menu-item" role="menuitem" href="/admin/feedback">Feedback triage</a>` +
              `<a class="menu-item" role="menuitem" href="/admin/screen-works">Screen works</a>` +
              `<hr class="menu-divider">` : '') +
          `<button class="menu-item" role="menuitem" type="button" data-logout>Log out</button>` +
        `</div>` +
      `</div>`
    : `<a class="btn btn-sm" href="/auth/login">Log in</a>`;
  return (
    `<header class="site-header">` +
      `<div class="site-header-inner">` +
        `<a class="brand" href="/" aria-label="Novel Adaptations — home"><span class="brand-wordmark">Novel Adaptations</span><span class="brand-arrow">.</span></a>` +
        `<nav class="main-nav" aria-label="Primary">${nav}</nav>` +
        `<button class="mobile-search-toggle" type="button" data-mobile-search aria-label="Search" aria-expanded="false">${SEARCH_SVG}</button>` +
        `<form class="header-search" data-header-search role="search" aria-label="Site search">` +
          `<input type="search" name="q" placeholder="Search books, movies, shows…" aria-label="Search books, movies, and shows" maxlength="100">` +
          `<button class="btn btn-sm" type="submit">Search</button>` +
        `</form>` +
        `<div class="header-actions">` +
          `<button class="theme-toggle" type="button" data-theme-toggle aria-label="${theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}" title="${theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}">` +
            `<span data-theme-icon="sun"${theme !== 'dark' ? ' hidden' : ''}>${SUN_SVG}</span>` +
            `<span data-theme-icon="moon"${theme === 'dark' ? ' hidden' : ''}>${MOON_SVG}</span>` +
          `</button>` +
          `<div class="header-user">${userArea}</div>` +
        `</div>` +
      `</div>` +
    `</header>` +
    mobileChromeHtml(pathname, theme, user, search)
  );
}

export function serverFooterHtml(): string {
  return (
    `<footer class="site-footer">` +
      `<div class="site-footer-inner">` +
        `<div class="footer-brand">` +
          `<span class="footer-wordmark">Novel Adaptations<span class="brand-arrow">.</span></span>` +
          `<p>Tracking every book's journey to the screen.</p>` +
          `<p class="copyright">© 2026 Novel Adaptations.</p>` +
          `<p class="footer-legal"><a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></p>` +
        `</div>` +
        `<nav aria-label="Footer">` +
          `<h2 class="footer-heading">Explore</h2>` +
          `<ul class="footer-links">` +
            `<li><a href="/">Home</a></li>` +
            `<li><a href="/calendar">Calendar</a></li>` +
            `<li><a href="/most-wanted">Most Wanted</a></li>` +
            `<li><a href="/lists">Lists</a></li>` +
            `<li><a href="/shelves">Shelves</a></li>` +
          `</ul>` +
        `</nav>` +
        `<div>` +
          `<h2 class="footer-heading">Feedback</h2>` +
          `<ul class="footer-links">` +
            `<li><a href="/feedback?type=feature">Suggest a feature</a></li>` +
            `<li><a href="/feedback?type=adaptation_tip">Report an adaptation</a></li>` +
            `<li><a href="/feedback?type=correction">Suggest a correction</a></li>` +
          `</ul>` +
        `</div>` +
        `<p class="footer-attribution tmdb-attribution">` +
          `This product uses the TMDB API but is not endorsed or certified by TMDB. ` +
          `Data and images via <a href="https://www.themoviedb.org/" target="_blank" rel="noopener noreferrer">The Movie Database</a>.` +
        `</p>` +
      `</div>` +
    `</footer>`
  );
}
