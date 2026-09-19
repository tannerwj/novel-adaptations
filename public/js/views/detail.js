// public/js/views/detail.js — Adaptation story, Book, and Screen-work pages.

import { esc, safeUrl, kindLabel, posterArt, releaseYear, HERO_SIZES } from '../utils.js';
import { bookUrl, watchUrl, adaptationUrl } from '../links.js';
import { api, errMsg } from '../api.js';
import { notFoundHtml } from '../router.js';
import { isAuthedResolved } from '../store.js';
import {
  adaptationCard, statusBadge, kindPill, statusTimeline, releaseNotes,
  newsList, voteButton, shelfPicker, wireUserControls,
} from '../components.js';
import { ratingWidget, pollWidget, hypeWidget, reviewsSection, addToListControl, wireWidgets } from '../widgets.js';

// ---------------------------------------------------------------------------
// /adaptations/:id — the adaptation story
// ---------------------------------------------------------------------------

export async function adaptationView({ params }) {
  const slug = String(params.slug ?? '').trim();
  if (!slug) return { title: 'Not found', html: notFoundHtml() };
  const r = await api(`/api/v1/adaptations/${encodeURIComponent(slug)}`, { loginRedirect: false });
  if (!r.ok) {
    if (r.status === 404 || r.status === 422) return { title: 'Not found', html: notFoundHtml() };
    throw new Error(errMsg(r));
  }
  const { adaptation: a, timeline, user_voted, user_shelf, poll } = r.data;
  const authed = isAuthedResolved();
  const correctionHref = `/feedback?type=correction&subject=${encodeURIComponent(a.screen_title)}`;

  return {
    title: a.screen_title,
    html:
      `<a class="back-link" href="/">← All adaptations</a>` +
      `<div class="hero">` +
        posterArt(a.screen_poster_url ?? a.book_cover_url, a.screen_title, `${kindLabel(a.screen_kind)} adaptation`, { eager: true, fetchpriority: 'high', sizes: HERO_SIZES }) +
        `<div>` +
          `<p class="kicker">${esc(kindLabel(a.screen_kind))} adaptation</p>` +
          `<h1>${esc(a.screen_title)}</h1>` +
          `<p class="byline">Based on <a href="${bookUrl(a)}"><em>${esc(a.book_title)}</em></a> by ${esc(a.book_authors)}</p>` +
          `<div class="hero-badges">${statusBadge(a.status)}` +
          (a.screen_release_date ? `<span class="kind-pill">📅 ${esc(a.screen_release_date)}</span>` : '') +
          `</div>` +
          `<div class="hero-actions">` +
            voteButton(a.book_id, user_voted) +
            shelfPicker('adaptation', a.id, user_shelf) +
            (!authed ? `<span class="meta">Log in to vote and shelve.</span>` : '') +
          `</div>` +
          `<p class="meta" style="margin-top:1rem"><a class="correction-link" href="${correctionHref}">Suggest a correction</a></p>` +
        `</div>` +
      `</div>` +
      `<section>` +
        `<h2 class="section-title">${a.status === 'released' ? 'Release notes' : 'Status timeline'}</h2>` +
        (a.status === 'released'
          ? releaseNotes(
              timeline && timeline.length > 0 ? timeline : [{ status: a.status, at: null, source_url: a.source_url }],
              a.screen_release_date,
            )
          : statusTimeline(timeline && timeline.length > 0 ? timeline : [{ status: a.status, at: null, source_url: a.source_url }])) +
      `</section>` +
      `<div class="detail-grid two">` +
        `<section class="panel"><h2>The book</h2><dl class="facts">` +
          `<dt>Title</dt><dd><a href="${bookUrl(a)}">${esc(a.book_title)}</a></dd>` +
          `<dt>Authors</dt><dd>${esc(a.book_authors)}</dd>` +
        `</dl></section>` +
        `<section class="panel"><h2>The screen work</h2><dl class="facts">` +
          `<dt>Title</dt><dd><a href="${watchUrl(a)}">${esc(a.screen_title)}</a></dd>` +
          `<dt>Kind</dt><dd>${esc(kindLabel(a.screen_kind))}</dd>` +
          `<dt>Release</dt><dd>${esc(a.screen_release_date ?? 'TBA')}</dd>` +
        `</dl>` +
        `</section>` +
      `</div>` +
      `<section class="panel" style="margin-top:1.5rem">` +
        pollWidget(a.id, poll?.counts, poll?.total ?? 0, poll?.user_choice ?? null, authed, {
          bookTitle: a.book_title, bookCover: a.book_cover_url,
          screenTitle: a.screen_title, screenPoster: a.screen_poster_url,
        }) +
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

/** Parse the JSON-encoded Open Library subjects array; never throws. */
function bookSubjects(raw) {
  if (!raw || typeof raw !== 'string') return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((s) => typeof s === 'string').slice(0, 8) : [];
  } catch {
    return [];
  }
}

export async function bookView({ params }) {
  const slug = String(params.slug ?? '').trim();
  if (!slug) return { title: 'Not found', html: notFoundHtml() };
  const r = await api(`/api/v1/books/${encodeURIComponent(slug)}`, { loginRedirect: false });
  if (!r.ok) {
    if (r.status === 404 || r.status === 422) return { title: 'Not found', html: notFoundHtml() };
    throw new Error(errMsg(r));
  }
  const b = r.data.book;
  const authed = isAuthedResolved();
  const correctionHref = `/feedback?type=correction&subject=${encodeURIComponent(b.title)}`;

  return {
    title: b.title,
    html:
      `<a class="back-link" href="/">← All adaptations</a>` +
      `<div class="hero">` +
        posterArt(b.cover_url, b.title, b.authors, { eager: true, fetchpriority: 'high', sizes: HERO_SIZES }) +
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
          `<p class="meta" style="margin-top:1rem"><a class="correction-link" href="${correctionHref}">Suggest a correction</a></p>` +
        `</div>` +
      `</div>` +
      `<div class="detail-grid">` +
        `<section class="panel"><h2>Details</h2><dl class="facts">` +
          `<dt>Published</dt><dd>${esc(b.pub_date ?? '—')}</dd>` +
          `<dt>ISBN</dt><dd>${esc(b.isbn ?? '—')}</dd>` +
          (bookSubjects(b.subjects).length > 0
            ? `<dt>Genres</dt><dd>${bookSubjects(b.subjects).map((s) => `<span class="kind-pill">${esc(s)}</span>`).join(' ')}</dd>`
            : '') +
        `</dl></section>` +
      `</div>` +
      (b.description && b.description.trim()
        ? `<section class="panel" style="margin-top:1.5rem"><h2>Synopsis</h2>` +
          `<p>${esc(b.description.trim())}</p>` +
          `<p class="meta">Synopsis via Open Library</p></section>`
        : '') +
      `<section>` +
        `<h2 class="section-title">Adaptations <span class="count">${r.data.adaptations.length}</span></h2>` +
        (r.data.adaptations.length === 0
          ? `<p class="meta">No screen adaptations tracked yet.</p>`
          : `<div class="poster-grid">${r.data.adaptations.map(adaptationCard).join('')}</div>`) +
      `</section>` +
      reviewsSection('book', b.id),
    after(root) { wireUserControls(root); wireWidgets(root); },
  };
}

// ---------------------------------------------------------------------------
// /watch/:id — the screen work
// ---------------------------------------------------------------------------

function whereToWatch(data, title) {
  if (!data) return '';
  // Merge the three TMDB provider groups into one deduplicated chip list.
  // Chips link to an exact-title JustWatch search — TMDB gives us provider
  // names/logos but no title-specific deep links, and we never invent them.
  const seen = new Set();
  const providers = [...(data.flatrate ?? []), ...(data.rent ?? []), ...(data.buy ?? [])]
    .filter((p) => p && p.name && !seen.has(String(p.name).toLowerCase()) && (seen.add(String(p.name).toLowerCase()), true));
  if (providers.length === 0) return '';
  const search = `https://www.justwatch.com/us/search?q=${encodeURIComponent(title ?? '')}`;
  return (
    `<section class="panel wtw"><h2>Where to watch</h2>` +
      `<ul class="wtw-chips">` +
      providers.map((p) =>
        `<li><a class="wtw-chip" href="${esc(search)}" target="_blank" rel="noopener noreferrer" ` +
          `title="Find ${esc(title)} on ${esc(p.name)} — JustWatch">` +
          (p.logo ? `<img src="${esc(p.logo)}" alt="" width="22" height="22" loading="lazy">` : '') +
          `<span>${esc(p.name)}</span>` +
        `</a></li>`
      ).join('') +
      `</ul>` +
      `<p class="meta wtw-caption">Watch provider data via JustWatch</p>` +
    `</section>`
  );
}

export async function watchView({ params }) {
  const slug = String(params.slug ?? '').trim();
  if (!slug) return { title: 'Not found', html: notFoundHtml() };
  const r = await api(`/api/v1/watch/${encodeURIComponent(slug)}`, { loginRedirect: false });
  if (!r.ok) {
    if (r.status === 404 || r.status === 422) return { title: 'Not found', html: notFoundHtml() };
    throw new Error(errMsg(r));
  }
  const w = r.data.work;
  const authed = isAuthedResolved();
  const year = releaseYear(w.release_date);
  const adaptLink = w.adaptations.length === 1
    ? `<a href="${adaptationUrl(w.adaptations[0])}">adaptation page →</a>`
    : `linked adaptation pages below.`;

  return {
    title: w.title,
    html:
      `<a class="back-link" href="/">← All adaptations</a>` +
      `<div class="hero">` +
        posterArt(w.poster_url, w.title, `${kindLabel(w.kind)}${year ? ` · ${year}` : ''}`, { eager: true, fetchpriority: 'high', sizes: HERO_SIZES }) +
        `<div>` +
          `<p class="kicker">The screen work — ${esc(kindLabel(w.kind).toLowerCase())}</p>` +
          `<h1>${esc(w.title)}</h1>` +
          `<p class="byline">${esc(kindLabel(w.kind))}${year ? ` · ${esc(year)}` : ''}</p>` +
          `<div class="hero-badges">${kindPill(w.kind)}` +
          (w.release_date ? `<span class="kind-pill">📅 ${esc(w.release_date)}</span>` : '') +
          `</div>` +
          `<p class="meta" style="margin-top:0.75rem">This page covers the film or series itself. For the full book-to-screen story and its status timeline, see the ${adaptLink}</p>` +
          `<div class="hero-actions">` +
            ratingWidget('screen_work', w.id, r.data.rating?.average ?? 0, r.data.rating?.count ?? 0, r.data.user_rating ?? null, authed) +
            addToListControl('screen_work', w.id, r.data.user_lists ?? [], authed) +
            `<button class="btn" type="button" data-trailer-btn>▶ Trailer</button>` +
          `</div>` +
        `</div>` +
      `</div>` +
      `<div data-trailer-slot></div>` +
      (r.data.hype
        ? hypeWidget(w.id, r.data.hype.average, r.data.hype.count, r.data.hype.user_level ?? null, authed)
        : '') +
      `<section class="panel" style="margin-top:1.5rem"><h2>Synopsis</h2>` +
        (w.synopsis && w.synopsis.trim()
          ? `<p>${esc(w.synopsis.trim())}</p>`
          : `<p class="empty" style="margin:0">Synopsis coming soon — we're pulling it in from TMDB.</p>`) +
      `</section>` +
      whereToWatch(r.data.watch_providers, w.title) +
      `<div class="detail-grid two" style="margin-top:1.5rem">` +
        `<section class="panel"><h2>Details</h2><dl class="facts">` +
          `<dt>Title</dt><dd>${esc(w.title)}</dd>` +
          `<dt>Kind</dt><dd>${esc(kindLabel(w.kind))}</dd>` +
          `<dt>Release</dt><dd>${esc(w.release_date ?? 'TBA')}</dd>` +
        `</dl></section>` +
        `<section class="panel"><h2>Cast &amp; crew</h2>` +
          `<p class="empty" style="margin:0">Cast and crew will appear once this page is filled in from TMDB.</p>` +
        `</section>` +
      `</div>` +
      `<section style="margin-top:2rem">` +
        `<h2 class="section-title">The books <span class="count">${w.books.length}</span></h2>` +
        (w.books.length === 0
          ? `<p class="empty">No linked books yet.</p>`
          : `<ul class="shelf-list panel">` +
            w.books.map((b) =>
              `<li><span><a href="${bookUrl(b)}">${esc(b.title)}</a><span class="meta"> by ${esc(b.authors)}</span></span>` +
              `<span class="shelf-kind kind-pill">📚 Book</span></li>`
            ).join('') + `</ul>`) +
      `</section>` +
      `<section style="margin-top:2rem">` +
        `<h2 class="section-title">The adaptation stories <span class="count">${w.adaptations.length}</span></h2>` +
        (w.adaptations.length === 0
          ? `<p class="empty">No adaptations tracked for this screen work yet.</p>`
          : `<ul class="shelf-list panel">` +
            w.adaptations.map((a) =>
              `<li><span><a href="${adaptationUrl(a)}">${esc(a.title)}</a></span>${statusBadge(a.status)}</li>`
            ).join('') + `</ul>`) +
      `</section>` +
      `<section style="margin-top:2rem">` +
        `<h2 class="section-title">Related news <span class="count">${r.data.news.length}</span></h2>` +
        (r.data.news.length === 0
          ? `<p class="empty">No news matched to this title's books yet.</p>`
          : newsList(r.data.news)) +
      `</section>` +
      reviewsSection('screen_work', w.id),
    after(root) { wireUserControls(root); wireWidgets(root); wireTrailer(root, slug); },
  };
}

/**
 * Trailer button: lazy-loads the YouTube key from the worker (which caches
 * the TMDB lookup in D1) and swaps in a privacy-enhanced embed. The button
 * stays visible even when no trailer exists — the lookup is cheap and cached.
 */
function wireTrailer(root, slug) {
  const btn = root.querySelector('[data-trailer-btn]');
  const slot = root.querySelector('[data-trailer-slot]');
  if (!btn || !slot || btn.dataset.wired) return;
  btn.dataset.wired = '1';
  btn.addEventListener('click', async () => {
    if (slot.dataset.loaded) {
      slot.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Loading…';
    try {
      const r = await api(`/api/v1/watch/${encodeURIComponent(slug)}/trailer`, { loginRedirect: false });
      if (!r.ok) throw new Error(errMsg(r));
      const key = r.data && r.data.youtube_key;
      if (key) {
        slot.dataset.loaded = '1';
        slot.innerHTML =
          `<div style="position:relative;padding-top:56.25%;margin-top:1.5rem;border-radius:12px;overflow:hidden;background:#000">` +
          `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(key)}?rel=0" ` +
          `title="Trailer" style="position:absolute;inset:0;width:100%;height:100%;border:0" ` +
          `allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" ` +
          `allowfullscreen loading="lazy"></iframe></div>`;
        slot.scrollIntoView({ behavior: 'smooth', block: 'center' });
        btn.textContent = '▶ Trailer';
      } else {
        slot.innerHTML = `<p class="empty" style="margin-top:1.5rem">No trailer found for this title yet.</p>`;
        btn.textContent = '▶ Trailer';
      }
    } catch (e) {
      slot.innerHTML = `<p class="empty" style="margin-top:1.5rem">Couldn't load the trailer — ${esc(e instanceof Error ? e.message : 'try again later')}.</p>`;
      btn.textContent = '▶ Trailer';
    } finally {
      btn.disabled = false;
    }
  });
}
