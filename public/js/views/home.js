// public/js/views/home.js — Home, Calendar, Most Wanted, Search.

import { esc, debounce, posterArt } from '../utils.js';
import { bookUrl, watchUrl, adaptationUrl } from '../links.js';
import { api, errMsg } from '../api.js';
import { navigate, replaceQuery } from '../router.js';
import { adaptationCard, statusBadge, kindPill, voteButton, wireUserControls, newsList } from '../components.js';

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

/** Rail / grid / radar sizes: small fixed limits, so no endpoint ever ships
 * the catalog to the client. Pagination still happens in SQL on every call. */
const FEATURED_RAIL_SIZE = 12;
const RECENT_GRID_SIZE = 8;
const RADAR_LIMIT = 6;
const NEWS_STRIP_SIZE = 6;

function chip(href, label) {
  return `<a class="chip" href="${href}">${esc(label)}</a>`;
}

function sectionHead(title, sub, viewAllHref, viewAllLabel) {
  return (
    `<div class="section-head">` +
      `<div>` +
        `<h2 class="home-section-title">${esc(title)}</h2>` +
        (sub ? `<p class="section-sub">${sub}</p>` : '') +
      `</div>` +
      (viewAllHref
        ? `<a class="view-all" href="${viewAllHref}">${esc(viewAllLabel)}</a>`
        : '') +
    `</div>`
  );
}

/** The hero search form navigates to the search page client-side — instant,
 * no full-page reload (router intercepts pushState + render). */
function wireHeroSearch(root) {
  const form = root.querySelector('[data-hero-search]');
  if (!form) return;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = new FormData(form).get('q');
    const query = typeof q === 'string' ? q.trim().slice(0, 100) : '';
    navigate(query ? `/search?q=${encodeURIComponent(query)}` : '/search');
  });
}

export async function homeView() {
  // Four small, SQL-paginated requests in parallel: featured rail (fixed
  // LIMIT 12), newest 8, the calendar buckets (already bucketed in SQL),
  // and the latest approved news. The unfiltered catalog total rides on the
  // adaptations page response — no extra call, and no endpoint ships more
  // than one page of rows.
  const [featuredRes, recentRes, calendarRes, newsRes] = await Promise.all([
    api(`/api/v1/home/featured?limit=${FEATURED_RAIL_SIZE}`, { loginRedirect: false }),
    api(`/api/v1/adaptations?sort=newest&per_page=${RECENT_GRID_SIZE}`, { loginRedirect: false }),
    api('/api/v1/calendar', { loginRedirect: false }),
    api(`/api/v1/news/recent?limit=${NEWS_STRIP_SIZE}`, { loginRedirect: false }),
  ]);
  const failed = [featuredRes, recentRes, calendarRes, newsRes].some((r) => !r.ok);
  const featured = featuredRes.ok ? (featuredRes.data.data ?? []) : [];
  const recent = recentRes.ok ? (recentRes.data.data ?? []) : [];
  const news = newsRes.ok ? (newsRes.data.items ?? []) : [];
  const total = recentRes.ok ? Number(recentRes.data.total ?? 0) : 0;
  const cal = calendarRes.ok ? calendarRes.data : null;
  const today = cal ? cal.today : null;
  const coming = cal ? (cal.coming_soon ?? []).slice(0, RADAR_LIMIT) : [];
  const landed = cal ? (cal.recently_released ?? []).slice(0, RADAR_LIMIT) : [];
  const totalFmt = total.toLocaleString('en-US');

  return {
    title: 'Home',
    html:
      `<section class="home-hero">` +
        `<p class="kicker">The adaptation tracker</p>` +
        `<h1 class="display-title">From the page to the screen.</h1>` +
        `<p class="lede">${total > 0 ? `${esc(totalFmt)} adaptations` : 'Adaptations'} tracked from rumor to release — search the catalog, see what's coming, and vote for the books you want adapted next.</p>` +
        `<form class="search-form home-search" data-hero-search role="search" aria-label="Search adaptations">` +
          `<input type="search" name="q" placeholder="Search books, movies, shows…" aria-label="Search books, movies, and shows" maxlength="100" autocomplete="off">` +
          `<button class="btn btn-primary" type="submit">Search</button>` +
        `</form>` +
        `<nav class="chip-row" aria-label="Browse">` +
          chip('/search?kind=film', 'Films') +
          chip('/search?kind=series', 'Series') +
          chip('/search?status=released', 'Released') +
          chip('/search?status=upcoming', 'Upcoming') +
          chip('/most-wanted', 'Most wanted') +
          chip('/calendar', 'Release calendar') +
        `</nav>` +
      `</section>` +
      (featured.length > 0
        ? `<section aria-label="Featured adaptations">` +
            sectionHead(
              'Featured',
              'The adaptations readers vote for most — ranked by community votes.',
            ) +
            `<div class="rail">${featured.map((a, i) => adaptationCard(a, { eager: i < 2 })).join('')}</div>` +
          `</section>`
        : '') +
      (recent.length > 0
        ? `<section aria-label="Recently added">` +
            sectionHead(
              'Recently added',
              'The newest additions to the catalog.',
              '/search',
              `Browse all ${esc(totalFmt)} →`,
            ) +
            `<div class="poster-grid">${recent.map((a) => adaptationCard(a)).join('')}</div>` +
          `</section>`
        : '') +
      `<section aria-label="Release radar">` +
        sectionHead('Release radar', 'What just landed and what is on its way.', '/calendar', 'Full calendar →') +
        `<div class="two-col">` +
          `<div>` +
            `<h3 class="cal-month">Coming soon</h3>` +
            (coming.length > 0
              ? `<ul class="shelf-list">${coming.map((w) => calendarItem(w, today)).join('')}</ul>`
              : `<p class="empty">No dated releases on the horizon yet.</p>`) +
          `</div>` +
          `<div>` +
            `<h3 class="cal-month">Recently released</h3>` +
            (landed.length > 0
              ? `<ul class="shelf-list">${landed.map((w) => calendarItem(w, today)).join('')}</ul>`
              : `<p class="empty">Nothing landed in the last 120 days.</p>`) +
          `</div>` +
        `</div>` +
      `</section>` +
      (news.length > 0
        ? `<section aria-label="Latest adaptation news">` +
            sectionHead('Latest news', 'Fresh from the adaptation newswire — curated by our editors.') +
            newsList(news) +
          `</section>`
        : '') +
      (total > 0
        ? `<section class="catalog-cta" aria-label="Browse the full catalog">` +
            `<h2 class="home-section-title">The whole shelf, one search away</h2>` +
            `<p class="section-sub">${esc(totalFmt)} adaptations — every film, series, and work in progress. Start typing above, or browse them all.</p>` +
            `<p><a class="btn btn-primary" href="/search">Browse all ${esc(totalFmt)} adaptations</a></p>` +
          `</section>`
        : '') +
      (failed
        ? `<p class="inline-error" role="alert">Some sections couldn't load. Check your connection and refresh.</p>`
        : ''),
    after(root) { wireUserControls(root); wireHeroSearch(root); },
  };
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DAY_MS = 86400000;

function cleanDate(w) {
  const d = (w.release_date || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(d) || /^\d{4}$/.test(d) ? d : null;
}
// Year-only dates (honest imprecision) display as just the year — never
// inflated into a fabricated month/day.
function displayDate(d) {
  return d.length === 4 ? d : formatDate(d);
}
function formatDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${d}, ${y}`;
}
function monthHeading(iso) {
  const [y, m] = iso.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}
function relativeLabel(iso, today) {
  const diff = Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  if (diff > 1) return `in ${diff} days`;
  return `${-diff} days ago`;
}
function calendarItem(w, today) {
  const d = cleanDate(w);
  const dateLabel = !d ? 'TBA' : d.length === 4 ? displayDate(d) : `${esc(formatDate(d))} · ${esc(relativeLabel(d, today))}`;
  return (
    `<li>` +
      `<a class="thumb-sm" href="${watchUrl(w)}" tabindex="-1" aria-hidden="true" style="width:44px;flex-shrink:0;display:block">` +
        posterArt(w.poster_url, w.title) +
      `</a>` +
      `<div style="min-width:0">` +
        `<a href="${watchUrl(w)}" style="color:var(--text);font-weight:600;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(w.title)}</a>` +
        `<span class="meta">${dateLabel}</span>` +
      `</div>` +
      `<span class="shelf-kind kind-pill">${esc(w.kind === 'series' ? 'Series' : 'Film')}</span>` +
    `</li>`
  );
}

export async function calendarView() {
  const r = await api('/api/v1/calendar', { loginRedirect: false });
  if (!r.ok) throw new Error(errMsg(r));
  const { today, coming_soon, recently_released, tba } = r.data;
  // Earlier releases arrive as year summaries; only the newest year's items
  // ship inline. Older years lazy-load from /api/v1/calendar/year/:year when
  // their <details> group is opened — no full-page reload, no 1,200-item DOM.
  const earlierYears = r.data.earlier_years || [];
  const newestItems = r.data.earlier_releases || [];

  const groups = [];
  for (const w of coming_soon) {
    const key = (cleanDate(w) || '').slice(0, 7);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.works.push(w);
    else groups.push({ key, heading: monthHeading(cleanDate(w) || ''), works: [w] });
  }

  const yearGroupHtml = (y, i) => {
    const items = i === 0 ? newestItems.map((w) => calendarItem(w, today)).join('') : '';
    return (
      `<details class="cal-year"${i === 0 ? ' open' : ''} data-cal-year="${esc(y.year)}">` +
      `<summary><span>${esc(y.year)}</span>` +
      `<span class="meta">${y.count} ${y.count === 1 ? 'title' : 'titles'}</span></summary>` +
      `<ul class="shelf-list" data-cal-items>${items}</ul></details>`
    );
  };

  return {
    title: 'Release calendar',
    html:
      `<p class="kicker">Release calendar</p>` +
      `<h1 style="font-family:var(--serif);font-size:2rem;margin:.25rem 0 .5rem">When books hit the screen</h1>` +
      `<p class="meta" style="margin-bottom:2rem">Every dated adaptation, in release order: upcoming first, then the last 120 days, then older releases, then the ones still waiting on a date.</p>` +
      `<section class="shelf-group"><h2>Coming soon</h2>` +
        (groups.length === 0
          ? `<p class="empty">No upcoming releases with dates yet.</p>`
          : groups.map((g) =>
              `<div class="cal-group"><h3 class="cal-month">${esc(g.heading)}</h3>` +
              `<ul class="shelf-list">${g.works.map((w) => calendarItem(w, today)).join('')}</ul></div>`
            ).join('')) +
      `</section>` +
      `<section class="shelf-group"><h2>Recently released</h2>` +
        (recently_released.length === 0
          ? `<p class="empty">Nothing released in the last 120 days.</p>`
          : `<ul class="shelf-list">${recently_released.map((w) => calendarItem(w, today)).join('')}</ul>`) +
      `</section>` +
      `<section class="shelf-group"><h2>Earlier releases</h2>` +
        (earlierYears.length === 0
          ? `<p class="empty">No earlier releases.</p>`
          : earlierYears.map(yearGroupHtml).join('')) +
      `</section>` +
      `<section class="shelf-group"><h2>TBA</h2>` +
        (tba.length === 0
          ? `<p class="empty">Everything here has a release date.</p>`
          : `<ul class="shelf-list">${tba.map((w) => calendarItem(w, today)).join('')}</ul>`) +
      `</section>`,
    after(root) { wireCalendarYears(root, today); },
  };
}

/**
 * Lazy-loads a calendar year group the first time its <details> opens.
 * Fetched years are cached on the element so repeat toggles never refetch.
 */
function wireCalendarYears(root, today) {
  const loaded = new Set();
  root.querySelectorAll('details[data-cal-year]').forEach((details) => {
    const year = details.dataset.calYear;
    if (details.open) loaded.add(year); // newest year ships inline
    details.addEventListener('toggle', async () => {
      if (!details.open || loaded.has(year)) return;
      loaded.add(year);
      const list = details.querySelector('[data-cal-items]');
      if (list) list.innerHTML = `<li><p class="meta">Loading ${esc(year)}…</p></li>`;
      const pr = await api(`/api/v1/calendar/year/${encodeURIComponent(year)}`, { loginRedirect: false });
      if (!pr.ok) {
        loaded.delete(year);
        if (list) list.innerHTML = `<li><p class="inline-error" role="alert">${esc(errMsg(pr))}</p></li>`;
        return;
      }
      if (list) {
        const works = pr.data.works || [];
        list.innerHTML = works.length > 0
          ? works.map((w) => calendarItem(w, today)).join('')
          : `<li><p class="empty">No titles for ${esc(year)}.</p></li>`;
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Most Wanted
// ---------------------------------------------------------------------------

function rankRow(item, i) {
  const b = item;
  return (
    `<li class="rank-row">` +
      `<div class="rank-num" aria-label="Rank ${i + 1}">${i + 1}</div>` +
      `<div class="rank-thumb">` +
        `<div class="mini-art" style="background:linear-gradient(135deg, hsl(${(i * 47) % 360}, 48%, 24%), hsl(${((i * 47) + 50) % 360}, 55%, 12%))">${esc(b.title.charAt(0))}</div>` +
        (b.cover_url && b.cover_url.trim() ? `<img src="${esc(b.cover_url.trim())}" alt="" loading="lazy" onerror="this.remove()">` : '') +
      `</div>` +
      `<div class="rank-info">` +
        `<p class="rank-title"><a href="${bookUrl(b)}">${esc(b.title)}</a></p>` +
        `<p class="rank-authors">${esc(b.authors)}</p>` +
      `</div>` +
      `<div class="rank-votes">` +
        `<div><div class="votes" data-vote-count-for="book-${b.book_id}">${b.votes}</div><div class="votes-label">votes</div></div>` +
        voteButton(b.book_id, b.user_voted, 'Voted ✓', 'Vote') +
      `</div>` +
    `</li>`
  );
}

export async function mostWantedView() {
  const r = await api('/api/v1/most-wanted?per_page=100', { loginRedirect: false });
  if (!r.ok) throw new Error(errMsg(r));
  const items = r.data.data;
  return {
    title: 'Most Wanted',
    html:
      `<p class="kicker">Community leaderboard</p>` +
      `<h1 class="display-title">Most Wanted Adaptations</h1>` +
      `<p class="lede">The books readers most want to see on screen. One vote per person.</p>` +
      (items.length === 0
        ? `<p class="empty">No votes yet. Be the first.</p>`
        : `<ol class="leaderboard">${items.map(rankRow).join('')}</ol>`),
    after(root) { wireUserControls(root); },
  };
}

// ---------------------------------------------------------------------------
// Search (live, no reload)
//
// Query params honored: ?q= (initial query), ?kind=film|series (filters
// films & series results), ?status=<adaptation status> (filters adaptation
// stories, and the browse catalog server-side). Empty query = browse the
// full adaptation catalog, paged through the SQL-paginated
// /api/v1/adaptations endpoint (24 rows at a time — never the whole
// catalog at once).
// ---------------------------------------------------------------------------

const SEARCH_MAX = 100;
const SEARCH_DEBOUNCE_MS = 250;
const BROWSE_PER_PAGE = 24;

const KIND_FILTERS = [
  { value: '', label: 'All' },
  { value: 'film', label: 'Films' },
  { value: 'series', label: 'Series' },
];
const STATUS_FILTERS = [
  { value: '', label: 'Any status' },
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'rumored', label: 'Rumored' },
  { value: 'optioned', label: 'Optioned' },
  { value: 'in_development', label: 'In development' },
  { value: 'filming', label: 'Filming' },
  { value: 'post_production', label: 'Post-production' },
  { value: 'released', label: 'Released' },
  { value: 'cancelled', label: 'Cancelled' },
];
const STATUS_LABELS = Object.fromEntries(STATUS_FILTERS.map((o) => [o.value, o.label]));

function validKind(v) {
  return KIND_FILTERS.some((o) => o.value === v) ? v : '';
}
function validStatus(v) {
  return STATUS_FILTERS.some((o) => o.value === v) ? v : '';
}

function bookThumb(title, coverUrl) {
  let h = 0;
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) % 360;
  const clean = coverUrl && coverUrl.trim() ? coverUrl.trim() : null;
  return (
    `<div class="rank-thumb">` +
      `<div class="mini-art" style="background:linear-gradient(135deg, hsl(${h}, 48%, 24%), hsl(${(h + 50) % 360}, 55%, 12%))">${esc(title.charAt(0))}</div>` +
      (clean ? `<img src="${esc(clean)}" alt="" loading="lazy" onerror="this.remove()">` : '') +
    `</div>`
  );
}

function popularHtml(books, heading) {
  if (!books || books.length === 0) return '';
  return (
    `<section aria-label="${esc(heading || 'Popular right now')}">` +
      `<h2 class="section-title">${esc(heading || 'Popular right now')}</h2>` +
      `<ol class="leaderboard">` +
      books.map((b, i) =>
        `<li class="rank-row">` +
          `<div class="rank-num" aria-label="Rank ${i + 1}">${i + 1}</div>` +
          bookThumb(b.title, b.cover_url) +
          `<div class="rank-info"><p class="rank-title"><a href="${bookUrl(b)}">${esc(b.title)}</a></p><p class="rank-authors">${esc(b.authors)}</p></div>` +
          `<div class="rank-votes"><div><div class="votes">${b.votes}</div><div class="votes-label">votes</div></div></div>` +
        `</li>`
      ).join('') +
      `</ol>` +
    `</section>`
  );
}

/** Search groups arrive pre-filtered by the server (kind/status in SQL). */
function filterGroups(data) {
  return {
    books: data.books?.data ?? [],
    works: data.screen_works?.data ?? [],
    stories: data.adaptations?.data ?? [],
  };
}

/** Query string for /api/v1/search: text plus the active kind/status filters. */
function searchParams(qq, kind, status) {
  const p = new URLSearchParams({ q: qq, limit: '12' });
  if (kind) p.set('kind', kind);
  if (status) p.set('status', status);
  return p;
}

/**
 * "Suggest an adaptation" empty state. Links to /feedback with
 * type=adaptation_tip (the "this book has an adaptation" flavor) and the
 * query pre-filled as the subject — the feedback form reads both from the
 * query string. The router intercepts the link, so there's no reload.
 */
function noResultsHtml(q, popular) {
  const suggest = `/feedback?type=adaptation_tip&subject=${encodeURIComponent(q)}`;
  return (
    `<div class="empty-state">` +
      `<p class="kicker">No matches</p>` +
      `<h2>No results for “${esc(q)}”.</h2>` +
      `<p>Try a shorter title, check the spelling, or search by the author’s last name.</p>` +
      `<p><a class="btn btn-primary" href="${esc(suggest)}">Can’t find it? Suggest an adaptation</a></p>` +
    `</div>` +
    popularHtml(popular, 'Popular right now')
  );
}

/**
 * Grouped results with keyboard-navigable options: every result is
 * role="option" inside the listbox, and the combobox tracks the active one
 * via aria-activedescendant (wired in searchView's after()).
 */
function resultsHtml(groups) {
  const { books, works, stories } = groups;
  let n = 0;
  const optAttrs = () => `role="option" id="search-option-${n++}" aria-selected="false" tabindex="-1"`;
  let html = '';
  if (books.length > 0) {
    html += `<section aria-label="Books" style="margin-bottom:2.5rem">` +
      `<h2 class="section-title">Books <span class="count">${books.length}</span></h2>` +
      `<ul class="search-result-list">` +
      books.map((b) =>
        `<li ${optAttrs()}><a href="${bookUrl(b)}">${esc(b.title)}</a><span class="sub"> by ${esc(b.authors)}</span></li>`
      ).join('') +
      `</ul></section>`;
  }
  if (works.length > 0) {
    html += `<section aria-label="Films and series" style="margin-bottom:2.5rem">` +
      `<h2 class="section-title">Films &amp; series <span class="count">${works.length}</span></h2>` +
      `<div class="poster-grid">` +
      works.map((w) =>
        `<article class="poster-card" ${optAttrs()}>` +
          `<a class="poster-link" href="${watchUrl(w)}" aria-label="${esc(w.title)} — ${w.kind === 'film' ? 'Film' : 'Series'}">` +
            posterArt(w.poster_url, w.title, w.kind === 'film' ? 'Film' : 'Series') +
          `</a>` +
          `<div class="card-body"><h3 class="card-title"><a href="${watchUrl(w)}">${esc(w.title)}</a></h3>` +
          `<div class="card-badges">${kindPill(w.kind)}</div></div>` +
        `</article>`
      ).join('') +
      `</div></section>`;
  }
  if (stories.length > 0) {
    html += `<section aria-label="Adaptation stories" style="margin-bottom:2.5rem">` +
      `<h2 class="section-title">Adaptation stories <span class="count">${stories.length}</span></h2>` +
      `<ul class="search-result-list">` +
      stories.map((s) =>
        `<li class="adapt-story" ${optAttrs()}><a href="${adaptationUrl(s)}">${esc(s.book_title)} → ${esc(s.screen_title)}</a>` +
        `<span class="sub">${s.screen_kind === 'film' ? 'Film' : 'Series'} · by ${esc(s.book_authors)}</span>` +
        statusBadge(s.status) + `</li>`
      ).join('') +
      `</ul></section>`;
  }
  return html;
}

function browseHeading(kind, status) {
  const what = kind === 'film' ? 'films' : kind === 'series' ? 'series' : 'adaptations';
  const scope = status ? STATUS_LABELS[status].toLowerCase() : 'all';
  return `Browse ${scope} ${what}`;
}

function browseCountText(state) {
  const b = state.browse;
  const what = state.kind === 'film' ? 'films' : state.kind === 'series' ? 'series' : 'adaptations';
  // Every filter goes to the server, so the server total is always exact.
  return `Showing ${b.shown} of ${b.total} ${what}`;
}

function filtersHtml(kind, status) {
  return (
    `<div class="search-filters" data-search-filters role="group" aria-label="Filter results">` +
      `<span class="meta">Filter:</span>` +
      KIND_FILTERS.map((o) =>
        `<button type="button" class="filter-pill${o.value === kind ? ' active' : ''}" data-kind="${o.value}" aria-pressed="${o.value === kind}">${o.label}</button>`
      ).join('') +
      `<label class="filter-status">Status ` +
        `<select data-status-filter aria-label="Filter by adaptation status">` +
        STATUS_FILTERS.map((o) => `<option value="${o.value}"${o.value === status ? ' selected' : ''}>${o.label}</option>`).join('') +
        `</select></label>` +
    `</div>`
  );
}

export async function searchView({ query }) {
  const q = (query.q || '').trim().slice(0, SEARCH_MAX);
  const state = {
    q,
    kind: validKind(query.kind),
    status: validStatus(query.status),
    seq: 0,
    active: -1,
    browse: null,
  };

  const headingFor = () =>
    state.q
      ? `Results for <span style="font-style:italic">“${esc(state.q)}”</span>`
      : esc(browseHeading(state.kind, state.status));
  const titleFor = () => (state.q ? `Results for “${state.q}”` : browseHeading(state.kind, state.status));
  const pathFor = () => {
    const p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.kind) p.set('kind', state.kind);
    if (state.status) p.set('status', state.status);
    const s = p.toString();
    return s ? `/search?${s}` : '/search';
  };

  /**
   * Fetch the next browse page from the SQL-paginated adaptations endpoint.
   * Kind and status (including the virtual 'upcoming') filter server-side,
   * so every page arrives full and the total is exact — no client-side
   * discard, no multi-page hunt for a match.
   */
  const loadBrowsePage = async () => {
    const b = state.browse;
    const params = new URLSearchParams({ page: String(b.page + 1), per_page: String(BROWSE_PER_PAGE) });
    if (state.kind) params.set('kind', state.kind);
    if (state.status) params.set('status', state.status);
    const r = await api(`/api/v1/adaptations?${params}`, { loginRedirect: false });
    if (!r.ok) throw new Error(errMsg(r));
    b.page = r.data.page;
    b.total = r.data.total;
    const added = r.data.data ?? [];
    if (b.page * r.data.per_page >= b.total || added.length === 0) b.exhausted = true;
    b.shown += added.length;
    return added;
  };

  const browseShell = (cardsHtml) => {
    const b = state.browse;
    return (
      (b.shown === 0
        ? `<p class="empty">Nothing here matches those filters yet. Try widening them — or ` +
          `<a href="/feedback?type=adaptation_tip">suggest an adaptation</a> we’re missing.</p>`
        : `<div class="poster-grid" data-browse-grid>${cardsHtml}</div>`) +
      `<p class="meta" data-browse-count>${esc(browseCountText(state))}</p>` +
      (!b.exhausted
        ? `<div class="load-more-wrap"><button type="button" class="btn" data-browse-more>Load more</button></div>`
        : '')
    );
  };

  let initialHtml;
  if (q) {
    const r = await api(`/api/v1/search?${searchParams(q, state.kind, state.status)}`, { loginRedirect: false });
    if (!r.ok) throw new Error(errMsg(r));
    const groups = filterGroups(r.data);
    const total = groups.books.length + groups.works.length + groups.stories.length;
    initialHtml = total === 0 ? noResultsHtml(q, r.data.popular) : resultsHtml(groups);
  } else {
    state.browse = { page: 0, total: 0, shown: 0, exhausted: false };
    const first = await loadBrowsePage();
    initialHtml = browseShell(first.map((a) => adaptationCard(a)).join(''));
  }

  return {
    title: titleFor(),
    html:
      `<p class="kicker">Search</p>` +
      `<h1 class="display-title" data-search-heading>${headingFor()}</h1>` +
      `<form class="search-form" data-search-form role="search" aria-label="Site search">` +
        `<input type="search" name="q" value="${esc(q)}" placeholder="Search books, movies, shows…" ` +
          `aria-label="Search books, movies, and shows" maxlength="${SEARCH_MAX}" ` +
          `role="combobox" aria-expanded="false" aria-controls="search-results" aria-autocomplete="list">` +
        `<button class="btn btn-primary" type="submit">Search</button>` +
      `</form>` +
      filtersHtml(state.kind, state.status) +
      `<div data-search-results id="search-results" aria-live="polite">${initialHtml}</div>`,
    after(root) {
      const form = root.querySelector('[data-search-form]');
      const input = form.querySelector('input[name="q"]');
      const slot = root.querySelector('[data-search-results]');
      const heading = root.querySelector('[data-search-heading]');

      const options = () => Array.from(slot.querySelectorAll('[role="option"]'));

      const setActive = (i) => {
        const opts = options();
        opts.forEach((o) => o.setAttribute('aria-selected', 'false'));
        state.active = i;
        if (i >= 0 && opts[i]) {
          opts[i].setAttribute('aria-selected', 'true');
          input.setAttribute('aria-activedescendant', opts[i].id);
          opts[i].scrollIntoView({ block: 'nearest' });
        } else {
          input.removeAttribute('aria-activedescendant');
        }
      };

      /** Keep the combobox/listbox ARIA in sync with what's rendered. */
      const syncA11y = () => {
        const has = options().length > 0;
        input.setAttribute('aria-expanded', has ? 'true' : 'false');
        if (has) slot.setAttribute('role', 'listbox');
        else slot.removeAttribute('role');
      };

      const refreshChrome = () => {
        replaceQuery(pathFor());
        if (heading) heading.innerHTML = headingFor();
        document.title = `${titleFor()} — Novel Adaptations`;
      };

      const renderSearchResults = async (qq) => {
        const my = ++state.seq;
        const res = await api(`/api/v1/search?${searchParams(qq, state.kind, state.status)}`, { loginRedirect: false });
        if (my !== state.seq || !res.ok) return;
        const groups = filterGroups(res.data);
        const total = groups.books.length + groups.works.length + groups.stories.length;
        slot.innerHTML = total === 0 ? noResultsHtml(qq, res.data.popular) : resultsHtml(groups);
        setActive(-1);
        syncA11y();
        wireUserControls(slot);
      };

      const renderBrowse = async (fresh) => {
        const my = ++state.seq;
        try {
          const added = await loadBrowsePage();
          if (my !== state.seq) return;
          const cards = added.map((a) => adaptationCard(a)).join('');
          if (fresh) {
            slot.innerHTML = browseShell(cards);
          } else {
            const grid = slot.querySelector('[data-browse-grid]');
            if (grid && cards) {
              grid.insertAdjacentHTML('beforeend', cards);
              wireUserControls(grid);
            }
            const countEl = slot.querySelector('[data-browse-count]');
            if (countEl) countEl.textContent = browseCountText(state);
            if (state.browse.exhausted) slot.querySelector('[data-browse-more]')?.closest('.load-more-wrap')?.remove();
          }
          syncA11y();
        } catch (e) {
          if (my === state.seq) slot.innerHTML = `<p class="inline-error" role="alert">${esc(errMsg(e))}</p>`;
        }
      };

      /** Re-run after the query or filters change: no reload, URL updated. */
      const rerun = () => {
        refreshChrome();
        setActive(-1);
        if (state.q) {
          state.browse = null;
          renderSearchResults(state.q);
        } else {
          state.browse = { page: 0, total: 0, shown: 0, exhausted: false };
          renderBrowse(true);
        }
      };

      const debounced = debounce(() => {
        const qq = input.value.trim().slice(0, SEARCH_MAX);
        if (qq === state.q) return;
        state.q = qq;
        rerun();
      }, SEARCH_DEBOUNCE_MS);

      input.addEventListener('input', debounced);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const qq = input.value.trim().slice(0, SEARCH_MAX);
        if (qq === state.q && state.q) return;
        state.q = qq;
        rerun();
      });

      // Keyboard: arrows move through results, Enter opens, Escape clears.
      input.addEventListener('keydown', (e) => {
        const opts = options();
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          if (opts.length === 0) return;
          e.preventDefault();
          const dir = e.key === 'ArrowDown' ? 1 : -1;
          setActive(state.active < 0 ? (dir > 0 ? 0 : opts.length - 1) : (state.active + dir + opts.length) % opts.length);
        } else if (e.key === 'Home' && opts.length > 0) {
          e.preventDefault();
          setActive(0);
        } else if (e.key === 'End' && opts.length > 0) {
          e.preventDefault();
          setActive(opts.length - 1);
        } else if (e.key === 'Enter') {
          const opt = state.active >= 0 ? opts[state.active] : null;
          const a = opt && opt.querySelector('a[href]');
          if (a) {
            e.preventDefault();
            navigate(a.getAttribute('href'));
          }
        } else if (e.key === 'Escape') {
          if (input.value) {
            input.value = '';
            state.q = '';
            rerun();
          }
          setActive(-1);
          input.blur();
        }
      });

      // Kind pills + status select: update filters, URL, and results in place.
      root.querySelector('[data-search-filters]').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-kind]');
        if (!btn || btn.dataset.kind === state.kind) return;
        state.kind = btn.dataset.kind;
        root.querySelectorAll('[data-kind]').forEach((pill) => {
          const on = pill.dataset.kind === state.kind;
          pill.classList.toggle('active', on);
          pill.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        rerun();
      });
      root.querySelector('[data-status-filter]').addEventListener('change', (e) => {
        state.status = e.target.value;
        rerun();
      });

      // Browse "Load more" (event delegation — the button is re-created).
      slot.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-browse-more]');
        if (!btn || btn.disabled || state.q) return;
        btn.disabled = true;
        const label = btn.textContent;
        btn.textContent = 'Loading…';
        const my = state.seq;
        try {
          const added = await loadBrowsePage();
          if (my !== state.seq) return;
          const grid = slot.querySelector('[data-browse-grid]');
          if (grid && added.length > 0) {
            grid.insertAdjacentHTML('beforeend', added.map((a) => adaptationCard(a)).join(''));
            wireUserControls(grid);
          }
          const countEl = slot.querySelector('[data-browse-count]');
          if (countEl) countEl.textContent = browseCountText(state);
          if (state.browse.exhausted) btn.closest('.load-more-wrap')?.remove();
          else {
            btn.disabled = false;
            btn.textContent = label;
          }
        } catch (err) {
          btn.disabled = false;
          btn.textContent = label;
          btn.insertAdjacentHTML('afterend', `<p class="inline-error" role="alert">${esc(errMsg(err))}</p>`);
        }
      });

      syncA11y();
      wireUserControls(slot);
    },
  };
}
