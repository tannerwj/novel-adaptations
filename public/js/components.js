// public/js/components.js — shared chrome: header, footer, cards, badges,
// forms, pagination, and the shelf picker. Mirrors src/ui.tsx's Layout
// (same classes, same design tokens) so the SPA has visual parity with the
// server-rendered pages it replaces.

import { esc, safeUrl, statusLabel, kindLabel, shelfLabel, tierLabel, posterArt, initialsFor } from './utils.js';
import { store, toggleTheme } from './store.js';
import { navigate } from './router.js';
import { api } from './api.js';

const SUN_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`;
const MOON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>`;
const SEARCH_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>`;
const HOME_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>`;
const CAL_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>`;
const STAR_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l2.7 5.8 6.3.7-4.7 4.3 1.3 6.2L12 16.9 6.4 20l1.3-6.2L3 9.5l6.3-.7z"/></svg>`;
const DOTS_SVG = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>`;

// --- badges -----------------------------------------------------------------

const KNOWN_STATUSES = new Set([
  'rumored', 'optioned', 'in_development', 'filming',
  'post_production', 'released', 'cancelled',
]);

export function statusBadge(status) {
  const s = String(status ?? '');
  const cls = KNOWN_STATUSES.has(s) ? `status-${s}` : 'status-unknown';
  return `<span class="status-badge ${cls}">${esc(statusLabel(s))}</span>`;
}

export function trustBadge(tier) {
  return `<span class="tier-badge tier-${esc(tier)}">${esc(tierLabel(tier))}</span>`;
}

export function kindPill(kind) {
  return `<span class="kind-pill">${esc(kindLabel(kind))}</span>`;
}

// --- cards ------------------------------------------------------------------

/** Poster card for the home grid / search results (adaptation object, v1 snake_case). */
export function adaptationCard(a, opts) {
  const eager = !!(opts && opts.eager);
  return (
    `<article class="poster-card">` +
      `<a class="poster-link" href="/watch/${a.screen_work_id}">` +
        posterArt(a.screen_poster_url ?? a.book_cover_url, a.screen_title, `${kindLabel(a.screen_kind)} · ${a.book_authors}`, eager ? { eager: true, fetchpriority: 'high' } : null) +
      `</a>` +
      `<div class="card-body">` +
        `<h2 class="card-title"><a href="/adaptations/${a.id}">${esc(a.screen_title)}</a></h2>` +
        `<p class="card-meta">from <a href="/books/${a.book_id}">${esc(a.book_title)}</a> by ${esc(a.book_authors)}</p>` +
        `<div class="card-badges">${kindPill(a.screen_kind)}${statusBadge(a.status)}</div>` +
      `</div>` +
    `</article>`
  );
}

// --- status timeline ----------------------------------------------------------

const PIPELINE = ['rumored', 'optioned', 'in_development', 'filming', 'post_production', 'released'];

export function statusTimeline(events) {
  const evts = Array.isArray(events) ? events : [];
  const cancelled = evts.find((e) => e.status === 'cancelled');
  if (cancelled) {
    return (
      `<div class="timeline"><ol>` +
        `<li class="current"><span class="dot">✕</span><div class="step-label">Cancelled</div>` +
        `<div class="step-meta">${esc(cancelled.at ?? 'date unknown')}` +
        (cancelled.source_url && safeUrl(cancelled.source_url)
          ? ` · <a href="${esc(cancelled.source_url)}" target="_blank" rel="noopener noreferrer">source</a>` : '') +
        `</div></li>` +
      `</ol></div>`
    );
  }
  const byStatus = new Map();
  for (const e of evts) if (!byStatus.has(e.status)) byStatus.set(e.status, e);
  let currentIdx = -1;
  PIPELINE.forEach((s, i) => {
    const e = byStatus.get(s);
    if (e && e.at) currentIdx = i;
  });
  if (currentIdx === -1) {
    const last = evts[evts.length - 1];
    if (last) currentIdx = PIPELINE.indexOf(last.status);
  }
  return (
    `<div class="timeline"><ol>` +
    PIPELINE.map((s, i) => {
      const e = byStatus.get(s);
      const state = i < currentIdx ? 'done' : i === currentIdx ? 'current' : 'upcoming';
      return (
        `<li class="${state}">` +
          `<span class="dot" aria-hidden="true">${state === 'done' ? '✓' : ''}</span>` +
          `<div class="step-label">${esc(statusLabel(s))}</div>` +
          `<div class="step-meta">${esc(e?.at ?? '—')}` +
          (e?.source_url && safeUrl(e.source_url)
            ? ` · <a href="${esc(e.source_url)}" target="_blank" rel="noopener noreferrer">source</a>` : '') +
          `</div>` +
        `</li>`
      );
    }).join('') +
    `</ol></div>`
  );
}

// --- news list ----------------------------------------------------------------

export function newsList(items) {
  if (!items || items.length === 0) return `<p class="meta">No news yet for this title.</p>`;
  return (
    `<ul class="news-list panel">` +
    items.map((n) => {
      const href = safeUrl(n.url) || '#';
      return (
        `<li>` +
          `<p class="news-title"><a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(n.title)}</a></p>` +
          `<p class="news-meta">${trustBadge(n.trust_tier)}<span>${esc(n.source)}</span>` +
          (n.published_at ? `<span>${esc(n.published_at)}</span>` : '') +
          `</p>` +
        `</li>`
      );
    }).join('') +
    `</ul>`
  );
}

// --- vote button + shelf picker -----------------------------------------------

/** Vote/unvote button (books). Posts to /api/v1/votes; logged-out → login. */
export function voteButton(bookId, userVoted, labelVoted = 'Voted ✓', labelVote = 'Vote: adapt this') {
  return (
    `<button type="button" class="btn vote-btn${userVoted ? ' voted' : ''}" ` +
      `data-vote-btn data-book-id="${bookId}" aria-pressed="${userVoted ? 'true' : 'false'}">` +
      `<span class="vote-label">${esc(userVoted ? labelVoted : labelVote)}</span>` +
    `</button>`
  );
}

const SHELVES = ['want_to_read', 'read', 'want_to_watch', 'watched'];

/** Shelf picker wired to /api/v1/shelves. targetType: 'book' | 'adaptation'. */
export function shelfPicker(targetType, targetId, userShelf) {
  return (
    `<select class="shelf-select" data-shelf-select data-target-type="${esc(targetType)}" data-target-id="${targetId}" ` +
      `title="Add to a shelf" aria-label="Add to a shelf">` +
      `<option value="">＋ Shelf…</option>` +
      SHELVES.map((s) =>
        `<option value="${s}"${userShelf === s ? ' selected' : ''}>${userShelf === s ? '✓ ' : ''}${esc(shelfLabel(s))}</option>`
      ).join('') +
    `</select>`
  );
}

/** Wire every [data-vote-btn] and [data-shelf-select] under root. Logged-out users go to /auth/login. */
export function wireUserControls(root) {
  root.querySelectorAll('[data-vote-btn]').forEach((btn) => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', async () => {
      if (!store.user) { navigate('/auth/login?next=' + encodeURIComponent(window.location.pathname)); return; }
      const bookId = Number(btn.dataset.bookId);
      const voted = btn.classList.contains('voted');
      const label = btn.querySelector('.vote-label');
      if (label && !btn.dataset.labelOrig) btn.dataset.labelOrig = label.textContent || '';
      btn.disabled = true;
      const r = voted
        ? await api(`/api/v1/votes/${bookId}`, { method: 'DELETE' })
        : await api('/api/v1/votes', { method: 'POST', body: { book_id: bookId } });
      btn.disabled = false;
      if (!r.ok) {
        if (r.code === 'rate_limited') alert('Slow down — you get 20 votes per day.');
        else if (r.status !== 401) alert(r.message);
        return;
      }
      const countEl = root.querySelector(`[data-vote-count-for="book-${bookId}"]`);
      if (typeof r.data.votes === 'number' && countEl) countEl.textContent = r.data.votes;
      btn.classList.toggle('voted', !voted);
      btn.setAttribute('aria-pressed', String(!voted));
      if (label) label.textContent = !voted ? 'Voted ✓' : (btn.dataset.labelOrig || 'Vote');
    });
  });

  root.querySelectorAll('[data-shelf-select]').forEach((sel) => {
    if (sel.dataset.wired) return;
    sel.dataset.wired = '1';
    sel.addEventListener('change', async () => {
      if (!store.user) {
        sel.value = '';
        navigate('/auth/login?next=' + encodeURIComponent(window.location.pathname));
        return;
      }
      const body = { target_type: sel.dataset.targetType, target_id: Number(sel.dataset.targetId) };
      const shelf = sel.value || null;
      const r = shelf
        ? await api('/api/v1/shelves', { method: 'POST', body: { ...body, shelf } })
        : await api('/api/v1/shelves', { method: 'DELETE', body });
      if (!r.ok && r.status !== 401) alert(r.message);
    });
  });
}

// --- pagination -----------------------------------------------------------------

export function pagination(page, perPage, total, onPage) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  if (pages <= 1) return '';
  return (
    `<nav class="pagination" aria-label="Pagination">` +
      (page > 1 ? `<button class="btn btn-sm" data-page="${page - 1}">← Prev</button>` : '') +
      `<span>Page ${page} of ${pages}</span>` +
      (page < pages ? `<button class="btn btn-sm" data-page="${page + 1}">Next →</button>` : '') +
    `</nav>`
  );
}

export function wirePagination(root, go) {
  root.querySelectorAll('[data-page]').forEach((btn) => {
    btn.addEventListener('click', () => go(Number(btn.dataset.page)));
  });
}

// --- mobile chrome: slim header toggle, bottom tab bar, More sheet ----------
// Mirrors src/spa/chrome.ts mobileChromeHtml() — the two must stay
// byte-identical for the same inputs (pathname, theme, user).

/** Which bottom-tab is active for a pathname; detail pages → no tab. */
function mobileTabFor(pathname) {
  if (pathname === '/') return 'home';
  if (pathname === '/calendar' || pathname.startsWith('/calendar/')) return 'calendar';
  if (pathname === '/most-wanted' || pathname.startsWith('/most-wanted/')) return 'most-wanted';
  if (pathname === '/search' || pathname.startsWith('/search/')) return 'search';
  return null;
}

/** Which More-sheet item is active; null when the sheet has no match. */
function moreItemFor(path) {
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

function mobileChromeHtml(pathname) {
  const user = store.user;
  const theme = store.theme;
  const tab = mobileTabFor(pathname);
  const moreItem = moreItemFor(pathname + window.location.search);
  const tabLink = (id, href, label, icon) => {
    const active = tab === id;
    return `<a class="tab-link${active ? ' active' : ''}" href="${href}"${active ? ' aria-current="page"' : ''}>` +
      `<span class="tab-pill" aria-hidden="true">${icon}</span><span class="tab-label">${label}</span></a>`;
  };
  const sheetItem = (id, href, icon, label) =>
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
        (user && user.is_admin
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

// --- header / footer --------------------------------------------------------------

const NAV_LINKS = [
  ['/', 'Home'],
  ['/calendar', 'Calendar'],
  ['/most-wanted', 'Most Wanted'],
  ['/lists', 'Lists'],
  ['/shelves', 'Shelves'],
];

export function headerHtml(pathname) {
  const user = store.user;
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
          (user.is_admin
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
        `<form class="header-search" data-header-search role="search">` +
          `<input type="search" name="q" placeholder="Search books, movies, shows…" aria-label="Search books, movies, and shows" maxlength="100">` +
          `<button class="btn btn-sm" type="submit">Search</button>` +
        `</form>` +
        `<div class="header-actions">` +
          `<button class="theme-toggle" type="button" data-theme-toggle aria-label="${store.theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}" title="${store.theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}">` +
            `<span data-theme-icon="sun"${store.theme !== 'dark' ? ' hidden' : ''}>${SUN_SVG}</span>` +
            `<span data-theme-icon="moon"${store.theme === 'dark' ? ' hidden' : ''}>${MOON_SVG}</span>` +
          `</button>` +
          `<div class="header-user">${userArea}</div>` +
        `</div>` +
      `</div>` +
    `</header>` +
    mobileChromeHtml(pathname)
  );
}

export function footerHtml() {
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

/**
 * Mount the persistent chrome (header + footer) once. #app sits between them.
 * The worker server-renders the chrome into #chrome-header/#chrome-footer
 * (see src/spa/chrome.ts) so first paint has no layout shift; when those
 * divs already exist we reuse them and refreshChrome() fills/refreshes the
 * inner HTML (a no-op when it matches the server render).
 * Re-call `refreshChrome()` on route change to update the active nav link and
 * on session change to update the user area.
 */
export function mountChrome() {
  const body = document.body;
  let headerWrap = document.getElementById('chrome-header');
  if (!headerWrap) {
    headerWrap = document.createElement('div');
    headerWrap.id = 'chrome-header';
    body.insertBefore(headerWrap, body.firstChild);
  }
  let footerWrap = document.getElementById('chrome-footer');
  if (!footerWrap) {
    footerWrap = document.createElement('div');
    footerWrap.id = 'chrome-footer';
    body.appendChild(footerWrap);
  }
  refreshChrome();
  wireChrome();
}

export function refreshChrome() {
  // A navigation re-renders the chrome wholesale: drop any open More sheet
  // state first, otherwise a sheet link could leave the body scroll-locked.
  document.body.classList.remove('sheet-open');
  const pathname = window.location.pathname;
  document.getElementById('chrome-header').innerHTML = headerHtml(pathname);
  document.getElementById('chrome-footer').innerHTML = footerHtml();
}

/** One-time wiring for chrome interactions: dropdown, theme toggle, search, logout,
 *  mobile search toggle, and the More bottom sheet. */
function wireChrome() {
  const moreEls = () => ({
    sheet: document.querySelector('[data-more-sheet]'),
    scrim: document.querySelector('[data-more-scrim]'),
    btn: document.querySelector('[data-more-btn]'),
  });
  const openMoreSheet = () => {
    const { sheet, scrim, btn } = moreEls();
    if (!sheet || !scrim || !btn || !sheet.hidden) return;
    sheet.hidden = false;
    scrim.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    document.body.classList.add('sheet-open');
    const first = sheet.querySelector('.sheet-item');
    if (first) first.focus();
  };
  const closeMoreSheet = (focusBtn = true) => {
    const { sheet, scrim, btn } = moreEls();
    if (!sheet || sheet.hidden) return;
    sheet.hidden = true;
    if (scrim) scrim.hidden = true;
    if (btn) {
      btn.setAttribute('aria-expanded', 'false');
      if (focusBtn) btn.focus();
    }
    document.body.classList.remove('sheet-open');
  };

  document.addEventListener('click', (e) => {
    const mSearch = e.target.closest('[data-mobile-search]');
    if (mSearch) {
      const header = mSearch.closest('.site-header');
      if (header) {
        const willOpen = !header.classList.contains('search-open');
        header.classList.toggle('search-open', willOpen);
        mSearch.setAttribute('aria-expanded', String(willOpen));
        if (willOpen) {
          const input = header.querySelector('.header-search input[type="search"]');
          if (input) input.focus();
        }
      }
      return;
    }
    const moreBtn = e.target.closest('[data-more-btn]');
    if (moreBtn) {
      const { sheet } = moreEls();
      if (sheet && sheet.hidden) openMoreSheet();
      else closeMoreSheet(false);
      return;
    }
    if (e.target.closest('[data-more-scrim]')) {
      closeMoreSheet();
      return;
    }
    const btn = e.target.closest('[data-user-menu-btn]');
    const menu = document.querySelector('[data-user-menu]');
    if (btn && menu) {
      e.stopPropagation();
      const willOpen = menu.hidden;
      menu.hidden = !willOpen;
      btn.setAttribute('aria-expanded', String(willOpen));
      return;
    }
    if (menu && !menu.hidden) {
      const inside = e.target.closest('[data-user-menu]') || e.target.closest('[data-user-menu-btn]');
      if (!inside) {
        menu.hidden = true;
        const b = document.querySelector('[data-user-menu-btn]');
        if (b) b.setAttribute('aria-expanded', 'false');
      }
    }
    const toggle = e.target.closest('[data-theme-toggle]');
    if (toggle) {
      e.preventDefault();
      toggleTheme();
      return;
    }
    const logout = e.target.closest('[data-logout]');
    if (logout) {
      e.preventDefault();
      doLogout();
    }
  });

  document.addEventListener('keydown', (e) => {
    // The More sheet is aria-modal: keep Tab/Shift+Tab cycling inside it
    // while open so keyboard users can't wander behind the scrim.
    if (e.key === 'Tab') {
      const sheet = document.querySelector('[data-more-sheet]');
      if (sheet && !sheet.hidden) {
        const items = [...sheet.querySelectorAll('a[href], button:not([disabled])')]
          .filter((el) => el.offsetParent !== null);
        if (items.length > 0) {
          const first = items[0];
          const last = items[items.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault(); last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault(); first.focus();
          }
        }
      }
      return;
    }
    if (e.key === 'Escape') {
      const menu = document.querySelector('[data-user-menu]');
      if (menu && !menu.hidden) {
        menu.hidden = true;
        const b = document.querySelector('[data-user-menu-btn]');
        if (b) { b.setAttribute('aria-expanded', 'false'); b.focus(); }
      }
      const openSearch = document.querySelector('.site-header.search-open');
      if (openSearch) {
        openSearch.classList.remove('search-open');
        const sb = openSearch.querySelector('[data-mobile-search]');
        if (sb) sb.setAttribute('aria-expanded', 'false');
      }
      closeMoreSheet();
    }
  });

  // Header search → /search?q=… without a reload.
  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (form && form.matches && form.matches('[data-header-search]')) {
      e.preventDefault();
      const q = new FormData(form).get('q');
      const qs = String(q || '').trim();
      navigate(qs ? '/search?q=' + encodeURIComponent(qs) : '/search');
    }
  });
}

async function doLogout() {
  await api('/api/v1/auth/logout', { method: 'POST', loginRedirect: false });
  store.user = null;
  refreshChrome();
  navigate('/');
}
