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
  const items = r.data.adaptations.data;
  return {
    title: 'Browse',
    html:
      `<p class="kicker">The adaptation tracker</p>` +
      `<h1 class="display-title">Every book's journey to the screen.</h1>` +
      `<p class="lede">From whispered rumors to opening night — follow novels as they're optioned, filmed, and released as movies and series.</p>` +
      (items.length === 0
        ? `<p class="empty">No adaptations tracked yet. Check back soon.</p>`
        : `<div class="poster-grid">${items.map((a, i) => adaptationCard(a, { eager: i < 2 })).join('')}</div>`),
    after(root) { wireUserControls(root); },
  };
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DAY_MS = 86400000;

function cleanDate(w) {
  const d = (w.release_date || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
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
  return (
    `<li>` +
      `<a class="thumb-sm" href="/watch/${w.id}" tabindex="-1" aria-hidden="true" style="width:44px;flex-shrink:0;display:block">` +
        posterArt(w.poster_url, w.title) +
      `</a>` +
      `<div style="min-width:0">` +
        `<a href="/watch/${w.id}" style="color:var(--text);font-weight:600;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(w.title)}</a>` +
        `<span class="meta">${d ? `${esc(formatDate(d))} · ${esc(relativeLabel(d, today))}` : 'TBA'}</span>` +
      `</div>` +
      `<span class="shelf-kind kind-pill">${esc(w.kind === 'series' ? 'Series' : 'Film')}</span>` +
    `</li>`
  );
}

export async function calendarView() {
  const r = await api('/api/v1/calendar', { loginRedirect: false });
  if (!r.ok) throw new Error(errMsg(r));
  const { today, coming_soon, recently_released, tba } = r.data;

  const groups = [];
  for (const w of coming_soon) {
    const key = (cleanDate(w) || '').slice(0, 7);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.works.push(w);
    else groups.push({ key, heading: monthHeading(cleanDate(w) || ''), works: [w] });
  }

  return {
    title: 'Release calendar',
    html:
      `<p class="kicker">Release calendar</p>` +
      `<h1 style="font-family:var(--serif);font-size:2rem;margin:.25rem 0 .5rem">When books hit the screen</h1>` +
      `<p class="meta" style="margin-bottom:2rem">Every dated adaptation, arranged by release — upcoming first, then the last 120 days, then the ones still waiting on a date.</p>` +
      `<section class="shelf-group"><h2>Coming soon</h2>` +
        (groups.length === 0
          ? `<p class="empty">Nothing dated in the pipeline yet.</p>`
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
      `<section class="shelf-group"><h2>TBA</h2>` +
        (tba.length === 0
          ? `<p class="empty">Every work has a date. Remarkable.</p>`
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
      `<p class="lede">The books readers most want to see on screen. One vote per person — make yours count.</p>` +
      (items.length === 0
        ? `<p class="empty">No votes yet. Be the first to champion a book.</p>`
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
