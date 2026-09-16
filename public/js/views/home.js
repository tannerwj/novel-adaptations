// public/js/views/home.js — Home, Calendar, Most Wanted, Search.

import { esc, debounce, posterArt } from '../utils.js';
import { api, errMsg } from '../api.js';
import { replaceQuery } from '../router.js';
import { adaptationCard, statusBadge, kindPill, voteButton, wireUserControls } from '../components.js';

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

export async function homeView() {
  const r = await api('/api/v1/home', { loginRedirect: false });
  if (!r.ok) throw new Error(errMsg(r));
  // /api/v1/home returns a paged list ({data, page, per_page, total}); the
  // grid starts with page 1 and a "Load more" button pages through the rest
  // via the same endpoint — instant, no reload, router-safe.
  const list = r.data.adaptations;
  const items = list.data;
  const total = list.total;
  const perPage = list.per_page;
  const remaining = total - items.length;
  return {
    title: 'Browse',
    html:
      `<p class="kicker">The adaptation tracker</p>` +
      `<h1 class="display-title">Every book's journey to the screen.</h1>` +
      `<p class="lede">Follow novels as they're optioned, filmed, and released as movies and series.</p>` +
      (items.length === 0
        ? `<p class="empty">No adaptations tracked yet. Check back soon.</p>`
        : `<div class="poster-grid" data-home-grid>${items.map((a, i) => adaptationCard(a, { eager: i < 2 })).join('')}</div>` +
          (remaining > 0
            ? `<div class="load-more-wrap"><button type="button" class="btn" data-load-more ` +
              `data-next-page="${list.page + 1}" data-per-page="${perPage}" data-total="${total}">` +
              `Load more <span class="meta" data-remaining>(${remaining} of ${total} remaining)</span></button></div>`
            : '')),
    after(root) { wireUserControls(root); wireLoadMore(root); },
  };
}

/**
 * "Load more" for the home grid: appends the next /api/v1/home page to the
 * grid in place. Appended cards are lazy (only the first two cards of the
 * initial page are eager), so below-fold images never regress LCP.
 */
function wireLoadMore(root) {
  const btn = root.querySelector('[data-load-more]');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    const label = btn.innerHTML;
    btn.textContent = 'Loading…';
    const nextPage = Number(btn.dataset.nextPage);
    const perPage = Number(btn.dataset.perPage);
    const total = Number(btn.dataset.total);
    const pr = await api(`/api/v1/home?page=${nextPage}&per_page=${perPage}`, { loginRedirect: false });
    if (!pr.ok) {
      btn.disabled = false;
      btn.innerHTML = label;
      btn.insertAdjacentHTML('afterend', `<p class="inline-error" role="alert">${esc(errMsg(pr))}</p>`);
      return;
    }
    const page = pr.data.adaptations;
    const grid = root.querySelector('[data-home-grid]');
    if (grid) {
      // Below-fold cards stay lazy — same as the initial page's tail.
      grid.insertAdjacentHTML('beforeend', page.data.map((a) => adaptationCard(a)).join(''));
      wireUserControls(grid);
    }
    const shown = grid ? grid.querySelectorAll('.poster-card').length : 0;
    const left = total - shown;
    const err = btn.parentElement.querySelector('.inline-error');
    if (err) err.remove();
    if (left > 0 && page.data.length > 0) {
      btn.dataset.nextPage = String(nextPage + 1);
      btn.disabled = false;
      btn.innerHTML = `Load more <span class="meta" data-remaining>(${left} of ${total} remaining)</span>`;
    } else {
      btn.closest('.load-more-wrap')?.remove();
    }
  });
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
      `<a class="thumb-sm" href="/watch/${w.id}" tabindex="-1" aria-hidden="true" style="width:44px;flex-shrink:0;display:block">` +
        posterArt(w.poster_url, w.title) +
      `</a>` +
      `<div style="min-width:0">` +
        `<a href="/watch/${w.id}" style="color:var(--text);font-weight:600;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(w.title)}</a>` +
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
  // Dated releases older than the 120-day window get their own section so no
  // dated work ever vanishes from the calendar.
  const earlier = r.data.earlier_releases || [];

  const groups = [];
  for (const w of coming_soon) {
    const key = (cleanDate(w) || '').slice(0, 7);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.works.push(w);
    else groups.push({ key, heading: monthHeading(cleanDate(w) || ''), works: [w] });
  }

  // earlier_releases arrives newest-first; group by release year, descending.
  const yearGroups = [];
  for (const w of earlier) {
    const year = (cleanDate(w) || '').slice(0, 4);
    const last = yearGroups[yearGroups.length - 1];
    if (last && last.year === year) last.works.push(w);
    else yearGroups.push({ year, works: [w] });
  }

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
        (yearGroups.length === 0
          ? `<p class="empty">No earlier releases.</p>`
          : yearGroups.map((g, i) =>
              `<details class="cal-year"${i === 0 ? ' open' : ''}>` +
              `<summary><span>${esc(g.year)}</span>` +
              `<span class="meta">${g.works.length} ${g.works.length === 1 ? 'title' : 'titles'}</span></summary>` +
              `<ul class="shelf-list">${g.works.map((w) => calendarItem(w, today)).join('')}</ul></details>`
            ).join('')) +
      `</section>` +
      `<section class="shelf-group"><h2>TBA</h2>` +
        (tba.length === 0
          ? `<p class="empty">Everything here has a release date.</p>`
          : `<ul class="shelf-list">${tba.map((w) => calendarItem(w, today)).join('')}</ul>`) +
      `</section>`,
  };
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
        `<p class="rank-title"><a href="/books/${b.book_id}">${esc(b.title)}</a></p>` +
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
// ---------------------------------------------------------------------------

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
          `<div class="rank-info"><p class="rank-title"><a href="/books/${b.id}">${esc(b.title)}</a></p><p class="rank-authors">${esc(b.authors)}</p></div>` +
          `<div class="rank-votes"><div><div class="votes">${b.votes}</div><div class="votes-label">votes</div></div></div>` +
        `</li>`
      ).join('') +
      `</ol>` +
    `</section>`
  );
}

function resultsHtml(q, data) {
  const books = data.books.data, works = data.screen_works.data, stories = data.adaptations.data;
  const total = books.length + works.length + stories.length;
  if (!q) {
    return data.popular.length > 0
      ? popularHtml(data.popular)
      : `<p class="empty">No books tracked yet. Check back soon.</p>`;
  }
  if (total === 0) {
    return `<p class="empty">No results for “${esc(q)}”. Try a different title or author spelling.</p>` +
      popularHtml(data.popular, 'Popular right now');
  }
  let html = '';
  if (books.length > 0) {
    html += `<section aria-label="Books" style="margin-bottom:2.5rem">` +
      `<h2 class="section-title">Books <span class="count">${books.length}</span></h2>` +
      `<ul class="search-result-list">` +
      books.map((b) => `<li><a href="/books/${b.id}">${esc(b.title)}</a><span class="sub"> by ${esc(b.authors)}</span></li>`).join('') +
      `</ul></section>`;
  }
  if (works.length > 0) {
    html += `<section aria-label="Films and series" style="margin-bottom:2.5rem">` +
      `<h2 class="section-title">Films &amp; series <span class="count">${works.length}</span></h2>` +
      `<div class="poster-grid">` +
      works.map((w) =>
        `<article class="poster-card">` +
          `<a class="poster-link" href="/watch/${w.id}" aria-label="${esc(w.title)} — ${w.kind === 'film' ? 'Film' : 'Series'}">` +
            posterArt(w.poster_url, w.title, w.kind === 'film' ? 'Film' : 'Series') +
          `</a>` +
          `<div class="card-body"><h3 class="card-title"><a href="/watch/${w.id}">${esc(w.title)}</a></h3>` +
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
        `<li class="adapt-story"><a href="/adaptations/${s.id}">${esc(s.book_title)} → ${esc(s.screen_title)}</a>` +
        `<span class="sub">${s.screen_kind === 'film' ? 'Film' : 'Series'} · by ${esc(s.book_authors)}</span>` +
        statusBadge(s.status) + `</li>`
      ).join('') +
      `</ul></section>`;
  }
  return html;
}

export async function searchView({ query }) {
  const q = (query.q || '').trim().slice(0, 100);
  const r = await api(`/api/v1/search?q=${encodeURIComponent(q)}&limit=12`, { loginRedirect: false });
  if (!r.ok) throw new Error(errMsg(r));
  return {
    title: q ? `Results for “${q}”` : 'Search',
    html:
      `<p class="kicker">Search</p>` +
      `<h1 class="display-title">${q ? `Results for <span style="font-style:italic">“${esc(q)}”</span>` : 'Search Novel Adaptations'}</h1>` +
      `<form class="search-form" data-search-form role="search">` +
        `<input type="search" name="q" value="${esc(q)}" placeholder="Search books, movies, shows…" aria-label="Search books, movies, and shows" maxlength="100">` +
        `<button class="btn btn-primary" type="submit">Search</button>` +
      `</form>` +
      `<div data-search-results aria-live="polite">${resultsHtml(q, r.data)}</div>`,
    after(root) {
      const form = root.querySelector('[data-search-form]');
      const input = form.querySelector('input[name="q"]');
      const slot = root.querySelector('[data-search-results]');
      let seq = 0;
      const run = async (qq) => {
        const my = ++seq;
        const res = await api(`/api/v1/search?q=${encodeURIComponent(qq)}&limit=12`, { loginRedirect: false });
        if (my !== seq || !res.ok) return;
        slot.innerHTML = resultsHtml(qq, res.data);
        wireUserControls(slot);
        document.title = `${qq ? `Results for “${qq}”` : 'Search'} — Novel Adaptations`;
      };
      const debounced = debounce(run, 300);
      input.addEventListener('input', () => {
        const qq = input.value.trim().slice(0, 100);
        replaceQuery(qq ? '/search?q=' + encodeURIComponent(qq) : '/search');
        debounced(qq);
      });
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const qq = input.value.trim().slice(0, 100);
        replaceQuery(qq ? '/search?q=' + encodeURIComponent(qq) : '/search');
        run(qq);
      });
    },
  };
}
