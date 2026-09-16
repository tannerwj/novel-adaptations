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

export function serverHeaderHtml(pathname: string, theme: ThemeName, user: ChromeUser | null): string {
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
        `<form class="header-search" data-header-search role="search">` +
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
    `</header>`
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
