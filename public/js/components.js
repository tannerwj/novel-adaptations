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
    `</header>`
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
  const pathname = window.location.pathname;
  document.getElementById('chrome-header').innerHTML = headerHtml(pathname);
  document.getElementById('chrome-footer').innerHTML = footerHtml();
}

/** One-time wiring for chrome interactions: dropdown, theme toggle, search, logout. */
function wireChrome() {
  document.addEventListener('click', (e) => {
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
    if (e.key === 'Escape') {
      const menu = document.querySelector('[data-user-menu]');
      if (menu && !menu.hidden) {
        menu.hidden = true;
        const b = document.querySelector('[data-user-menu-btn]');
        if (b) { b.setAttribute('aria-expanded', 'false'); b.focus(); }
      }
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
