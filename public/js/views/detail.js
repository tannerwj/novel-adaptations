// public/js/views/detail.js — Adaptation story, Book, and Screen-work pages.

import { esc, safeUrl, kindLabel, posterArt, releaseYear, tmdbUrl } from '../utils.js';
import { api, errMsg } from '../api.js';
import { renderNotFound } from '../router.js';
import { store } from '../store.js';
import {
  adaptationCard, statusBadge, kindPill, statusTimeline,
  newsList, voteButton, shelfPicker, wireUserControls,
} from '../components.js';
import { ratingWidget, pollWidget, hypeWidget, reviewsSection, addToListControl, wireWidgets } from '../widgets.js';

// ---------------------------------------------------------------------------
// /adaptations/:id — the adaptation story
// ---------------------------------------------------------------------------

export async function adaptationView({ params }) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id < 1) { renderNotFound(); return { title: 'Not found', html: '' }; }
  const r = await api(`/api/v1/adaptations/${id}`, { loginRedirect: false });
  if (!r.ok) {
    if (r.status === 404 || r.status === 422) { renderNotFound(); return { title: 'Not found', html: '' }; }
    throw new Error(errMsg(r));
  }
  const { adaptation: a, timeline, user_voted, user_shelf, poll } = r.data;
  const authed = !!store.user;
  const correctionHref = `/feedback?type=correction&subject=${encodeURIComponent(a.screen_title)}`;

  return {
    title: a.screen_title,
    html:
      `<a class="back-link" href="/">← All adaptations</a>` +
      `<div class="hero">` +
        posterArt(a.screen_poster_url ?? a.book_cover_url, a.screen_title, `${kindLabel(a.screen_kind)} adaptation`, { eager: true, fetchpriority: 'high' }) +
        `<div>` +
          `<p class="kicker">${esc(kindLabel(a.screen_kind))} adaptation</p>` +
          `<h1>${esc(a.screen_title)}</h1>` +
          `<p class="byline">Based on <a href="/books/${a.book_id}"><em>${esc(a.book_title)}</em></a> by ${esc(a.book_authors)}</p>` +
          `<div class="hero-badges">${statusBadge(a.status)}` +
          (a.screen_release_date ? `<span class="kind-pill">📅 ${esc(a.screen_release_date)}</span>` : '') +
          `</div>` +
          `<div class="hero-actions">` +
            voteButton(a.book_id, user_voted) +
            shelfPicker('adaptation', a.id, user_shelf) +
            (!authed ? `<span class="meta">Log in to vote and shelve.</span>` : '') +
          `</div>` +
          `<p class="meta" style="margin-top:1rem"><a href="${correctionHref}">Suggest a correction</a></p>` +
        `</div>` +
      `</div>` +
      `<section>` +
        `<h2 class="section-title">Status timeline</h2>` +
        statusTimeline(timeline && timeline.length > 0 ? timeline : [{ status: a.status, at: null, source_url: a.source_url }]) +
      `</section>` +
      `<div class="detail-grid two">` +
        `<section class="panel"><h2>The book</h2><dl class="facts">` +
          `<dt>Title</dt><dd><a href="/books/${a.book_id}">${esc(a.book_title)}</a></dd>` +
          `<dt>Authors</dt><dd>${esc(a.book_authors)}</dd>` +
        `</dl></section>` +
        `<section class="panel"><h2>The screen work</h2><dl class="facts">` +
          `<dt>Title</dt><dd>${esc(a.screen_title)}</dd>` +
          `<dt>Kind</dt><dd>${esc(kindLabel(a.screen_kind))}</dd>` +
          `<dt>Release</dt><dd>${esc(a.screen_release_date ?? 'TBA')}</dd>` +
        `</dl>` +
        `<p class="meta" style="margin-top:0.75rem"><a href="/watch/${a.screen_work_id}">View the screen work →</a> the film/series page, with synopsis, cast, and related news.</p>` +
        `</section>` +
      `</div>` +
      `<section class="panel" style="margin-top:1.5rem">` +
        pollWidget(a.id, poll?.counts, poll?.total ?? 0, poll?.user_choice ?? null, authed) +
      `</section>` +
      `<div class="detail-grid" style="margin-top:1.5rem">` +
        `<section class="panel"><h2>Adaptation status</h2><dl class="facts">` +
          `<dt>Status</dt><dd>${statusBadge(a.status)}</dd>` +
          `<dt>Source</dt><dd>${a.source_url && safeUrl(a.source_url) ? `<a href="${esc(a.source_url)}" target="_blank" rel="noopener noreferrer">source link ↗</a>` : '—'}</dd>` +
        `</dl></section>` +
      `</div>`,
    after(root) { wireUserControls(root); wireWidgets(root); },
  };
}

// ---------------------------------------------------------------------------
// /books/:id — the book
// ---------------------------------------------------------------------------

export async function bookView({ params }) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id < 1) { renderNotFound(); return { title: 'Not found', html: '' }; }
  const r = await api(`/api/v1/books/${id}`, { loginRedirect: false });
  if (!r.ok) {
    if (r.status === 404 || r.status === 422) { renderNotFound(); return { title: 'Not found', html: '' }; }
    throw new Error(errMsg(r));
  }
  const b = r.data.book;
  const authed = !!store.user;
  const correctionHref = `/feedback?type=correction&subject=${encodeURIComponent(b.title)}`;

  return {
    title: b.title,
    html:
      `<a class="back-link" href="/">← All adaptations</a>` +
      `<div class="hero">` +
        posterArt(b.cover_url, b.title, b.authors, { eager: true, fetchpriority: 'high' }) +
        `<div>` +
          `<p class="kicker">The book</p>` +
          `<h1>${esc(b.title)}</h1>` +
          `<p class="byline">by ${esc(b.authors)}</p>` +
          `<div class="hero-actions">` +
            voteButton(b.id, r.data.user_voted) +
            shelfPicker('book', b.id, r.data.user_shelf) +
            ratingWidget('book', b.id, r.data.rating?.average ?? 0, r.data.rating?.count ?? 0, r.data.user_rating ?? null, authed) +
            addToListControl('book', b.id, r.data.user_lists ?? [], authed) +
            (!authed ? `<span class="meta">Log in to vote and shelve.</span>` : '') +
          `</div>` +
          `<p class="meta" style="margin-top:1rem"><a href="${correctionHref}">Suggest a correction</a></p>` +
        `</div>` +
      `</div>` +
      `<div class="detail-grid">` +
        `<section class="panel"><h2>Details</h2><dl class="facts">` +
          `<dt>Published</dt><dd>${esc(b.pub_date ?? '—')}</dd>` +
          `<dt>ISBN</dt><dd>${esc(b.isbn ?? '—')}</dd>` +
        `</dl></section>` +
      `</div>` +
      `<section>` +
        `<h2 class="section-title">Adaptations <span class="count">${r.data.adaptations.length}</span></h2>` +
        (r.data.adaptations.length === 0
          ? `<p class="meta">No screen adaptations tracked yet — but the vote button above says it all.</p>`
          : `<div class="poster-grid">${r.data.adaptations.map(adaptationCard).join('')}</div>`) +
      `</section>` +
      reviewsSection('book', b.id),
    after(root) { wireUserControls(root); wireWidgets(root); },
  };
}

// ---------------------------------------------------------------------------
// /watch/:id — the screen work
// ---------------------------------------------------------------------------

function whereToWatch(data) {
  if (!data) return '';
  const hasAny = data.flatrate.length > 0 || data.rent.length > 0 || data.buy.length > 0;
  if (!hasAny && !data.link) return '';
  const group = (title, providers) => {
    if (!providers || providers.length === 0) return '';
    return (
      `<div style="margin-bottom:1rem">` +
        `<h3 class="meta" style="margin:0 0 0.5rem;text-transform:uppercase;letter-spacing:0.05em">${esc(title)}</h3>` +
        `<ul style="list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:0.75rem">` +
        providers.map((p) =>
          `<li style="display:flex;align-items:center;gap:0.5rem">` +
            `<img src="${esc(p.logo)}" alt="${esc(p.name)}" width="36" height="36" loading="lazy" style="border-radius:6px">` +
            `<span>${esc(p.name)}</span>` +
          `</li>`
        ).join('') +
        `</ul>` +
      `</div>`
    );
  };
  const link = safeUrl(data.link);
  return (
    `<section class="panel"><h2>Where to watch</h2>` +
      group('Stream', data.flatrate) + group('Rent', data.rent) + group('Buy', data.buy) +
      (link ? `<p style="margin:0.5rem 0 0"><a href="${esc(link)}" target="_blank" rel="noopener noreferrer">More options ↗</a></p>` : '') +
      `<p class="meta" style="margin:0.75rem 0 0;font-size:0.8rem">Watch provider data via JustWatch</p>` +
    `</section>`
  );
}

export async function watchView({ params }) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id < 1) { renderNotFound(); return { title: 'Not found', html: '' }; }
  const r = await api(`/api/v1/watch/${id}`, { loginRedirect: false });
  if (!r.ok) {
    if (r.status === 404 || r.status === 422) { renderNotFound(); return { title: 'Not found', html: '' }; }
    throw new Error(errMsg(r));
  }
  const w = r.data.work;
  const authed = !!store.user;
  const year = releaseYear(w.release_date);
  const adaptLink = w.adaptations.length === 1
    ? `<a href="/adaptations/${w.adaptations[0].id}">adaptation page →</a>`
    : `linked adaptation pages below.`;

  return {
    title: w.title,
    html:
      `<a class="back-link" href="/">← All adaptations</a>` +
      `<div class="hero">` +
        posterArt(w.backdrop_url ?? w.poster_url, w.title, `${kindLabel(w.kind)}${year ? ` · ${year}` : ''}`, { eager: true, fetchpriority: 'high' }) +
        `<div>` +
          `<p class="kicker">The screen work — ${esc(kindLabel(w.kind).toLowerCase())}</p>` +
          `<h1>${esc(w.title)}</h1>` +
          `<p class="byline">${esc(kindLabel(w.kind))}${year ? ` · ${esc(year)}` : ''}</p>` +
          `<div class="hero-badges">${kindPill(w.kind)}` +
          (w.release_date ? `<span class="kind-pill">📅 ${esc(w.release_date)}</span>` : '') +
          (w.tmdb_id ? `<a class="kind-pill" href="${esc(tmdbUrl(w.kind, w.tmdb_id))}" target="_blank" rel="noopener noreferrer">TMDB ↗</a>` : '') +
          `</div>` +
          `<p class="meta" style="margin-top:0.75rem">This page is about the screen work itself — the film or series. For the full book-to-screen story and its status timeline, see the ${adaptLink}</p>` +
          `<div class="hero-actions">` +
            ratingWidget('screen_work', w.id, r.data.rating?.average ?? 0, r.data.rating?.count ?? 0, r.data.user_rating ?? null, authed) +
            addToListControl('screen_work', w.id, r.data.user_lists ?? [], authed) +
          `</div>` +
        `</div>` +
      `</div>` +
      (r.data.hype
        ? hypeWidget(w.id, r.data.hype.average, r.data.hype.count, r.data.hype.user_level ?? null, authed)
        : '') +
      `<section class="panel" style="margin-top:1.5rem"><h2>Synopsis</h2>` +
        (w.synopsis && w.synopsis.trim()
          ? `<p>${esc(w.synopsis.trim())}</p>`
          : `<p class="empty" style="margin:0">Synopsis coming soon — we're enriching this page with data from TMDB.</p>`) +
      `</section>` +
      whereToWatch(r.data.watch_providers) +
      `<div class="detail-grid two" style="margin-top:1.5rem">` +
        `<section class="panel"><h2>Details</h2><dl class="facts">` +
          `<dt>Title</dt><dd>${esc(w.title)}</dd>` +
          `<dt>Kind</dt><dd>${esc(kindLabel(w.kind))}</dd>` +
          `<dt>Release</dt><dd>${esc(w.release_date ?? 'TBA')}</dd>` +
          `<dt>TMDB</dt><dd>${w.tmdb_id ? `<a href="${esc(tmdbUrl(w.kind, w.tmdb_id))}" target="_blank" rel="noopener noreferrer">View on TMDB ↗</a>` : '—'}</dd>` +
        `</dl></section>` +
        `<section class="panel"><h2>Cast &amp; crew</h2>` +
          `<p class="empty" style="margin:0">Cast and crew details arrive with TMDB enrichment — we don't guess at who's in it.</p>` +
        `</section>` +
      `</div>` +
      `<section style="margin-top:2rem">` +
        `<h2 class="section-title">The books <span class="count">${w.books.length}</span></h2>` +
        (w.books.length === 0
          ? `<p class="empty">No linked books yet.</p>`
          : `<ul class="shelf-list panel">` +
            w.books.map((b) =>
              `<li><span><a href="/books/${b.id}">${esc(b.title)}</a><span class="meta"> by ${esc(b.authors)}</span></span>` +
              `<span class="shelf-kind kind-pill">📚 Book</span></li>`
            ).join('') + `</ul>`) +
      `</section>` +
      `<section style="margin-top:2rem">` +
        `<h2 class="section-title">The adaptation stories <span class="count">${w.adaptations.length}</span></h2>` +
        (w.adaptations.length === 0
          ? `<p class="empty">No adaptations tracked for this screen work yet.</p>`
          : `<ul class="shelf-list panel">` +
            w.adaptations.map((a) =>
              `<li><span><a href="/adaptations/${a.id}">${esc(a.title)}</a></span>${statusBadge(a.status)}</li>`
            ).join('') + `</ul>`) +
      `</section>` +
      `<section style="margin-top:2rem">` +
        `<h2 class="section-title">Related news <span class="count">${r.data.news.length}</span></h2>` +
        (r.data.news.length === 0
          ? `<p class="empty">No news matched to this title's books yet — new stories appear here as the pipeline classifies them.</p>`
          : newsList(r.data.news)) +
      `</section>` +
      reviewsSection('screen_work', w.id),
    after(root) { wireUserControls(root); wireWidgets(root); },
  };
}
