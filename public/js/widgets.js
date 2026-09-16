// public/js/widgets.js — interactive community widgets: star ratings,
// book-vs-screen polls, hype meter, spoiler-safe reviews, add-to-list.
// All mutations go through /api/v1 (snake_case); every API text is escaped.

import { esc, displayName, dateOnly } from './utils.js';
import { api, errMsg } from './api.js';
import { store } from './store.js';

// ---------------------------------------------------------------------------
// Star ratings
// ---------------------------------------------------------------------------

export function ratingWidget(targetType, targetId, average, count, userRating, signedIn) {
  const current = signedIn ? (userRating ?? 0) : 0;
  const displayFilled = signedIn ? current : Math.round(average || 0);
  const stars = [1, 2, 3, 4, 5].map((n) =>
    signedIn
      ? `<button type="button" class="star${n <= current ? ' filled' : ''}" data-rating-star data-value="${n}" role="radio" aria-checked="${n === current ? 'true' : 'false'}" aria-label="${n} star${n === 1 ? '' : 's'}" title="Rate ${n} star${n === 1 ? '' : 's'}">★</button>`
      : `<span class="star${n <= displayFilled ? ' filled' : ''}" aria-hidden="true">★</span>`
  ).join('');
  return (
    `<div class="rating-widget" data-rating-widget data-target-type="${esc(targetType)}" data-target-id="${targetId}" ` +
      `data-signed-in="${signedIn ? '1' : '0'}" data-user-rating="${current}">` +
      `<span class="rating-stars"${signedIn ? ' role="radiogroup" aria-label="Your rating"' : ''}>${stars}</span>` +
      `<span class="rating-meta"><span class="rating-average" data-rating-average>${Number(average || 0).toFixed(1)}</span> · ` +
      `<span data-rating-count>${count} ${count === 1 ? 'rating' : 'ratings'}</span></span>` +
      (signedIn ? '' : `<a class="rating-login" href="/auth/login">Sign in to rate</a>`) +
    `</div>`
  );
}

export function wireRatings(root) {
  root.querySelectorAll('[data-rating-widget]').forEach((el) => {
    if (el.dataset.wired || el.dataset.signedIn !== '1') return;
    el.dataset.wired = '1';
    const targetType = el.dataset.targetType;
    const targetId = Number(el.dataset.targetId);
    let userRating = Number(el.dataset.userRating || 0);
    const stars = [...el.querySelectorAll('[data-rating-star]')];
    const avgEl = el.querySelector('[data-rating-average]');
    const countEl = el.querySelector('[data-rating-count]');
    const paint = (n) => stars.forEach((s, i) => s.classList.toggle('filled', i < n));
    stars.forEach((star, i) => {
      const v = i + 1;
      star.addEventListener('mouseenter', () => paint(v));
      star.addEventListener('mouseleave', () => paint(userRating));
      star.addEventListener('focus', () => paint(v));
      star.addEventListener('blur', () => paint(userRating));
      star.addEventListener('click', async () => {
        star.disabled = true;
        const r = await api('/api/v1/ratings', { method: 'POST', body: { target_type: targetType, target_id: targetId, rating: v } });
        star.disabled = false;
        if (!r.ok) {
          if (r.code === 'rate_limited') alert('Slow down — you can rate up to 60 titles per hour.');
          else if (r.status !== 401) alert(errMsg(r));
          return;
        }
        userRating = v;
        el.dataset.userRating = String(v);
        paint(v);
        stars.forEach((s, j) => s.setAttribute('aria-checked', String(j + 1 === v)));
        if (avgEl && typeof r.data.average === 'number') avgEl.textContent = r.data.average.toFixed(1);
        if (countEl && typeof r.data.count === 'number') countEl.textContent = `${r.data.count} ${r.data.count === 1 ? 'rating' : 'ratings'}`;
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Book-vs-screen poll — a modern duel: two tappable cards (Book vs Screen)
// with cover/poster art, animated percentage bars, live voter counts, and a
// clearly marked voted state. "Both great" / "Undecided" remain as secondary
// options. Votes POST to /api/v1/polls/:id (same request/response contract);
// results render in place with no reload.
// ---------------------------------------------------------------------------

const CHOICE_LABELS = { book: 'Book', screen: 'Screen', both: 'Both great', undecided: 'Undecided' };
const CHOICE_ORDER = ['book', 'screen', 'both', 'undecided'];
const DUEL_SIDES = { book: '📖 The book', screen: '🎬 The screen' };

function pollPct(n, total) {
  return total > 0 ? Math.round((n / total) * 100) : 0;
}

function duelArt(url, title) {
  const t = esc(title || '?');
  return url
    ? `<span class="duel-art"><img src="${esc(url)}" alt="" loading="lazy"></span>`
    : `<span class="duel-art" aria-hidden="true">${t.charAt(0)}</span>`;
}

function duelCard(choice, title, artUrl, n, total, userChoice) {
  const pct = pollPct(n, total);
  const mine = userChoice === choice;
  return (
    `<button type="button" class="duel-card${mine ? ' mine' : ''}" data-poll-btn="${choice}" data-poll-row="${choice}" ` +
    `aria-pressed="${mine ? 'true' : 'false'}" aria-label="${esc(CHOICE_LABELS[choice])}: ${esc(title)}">` +
      `<span class="duel-pick" aria-hidden="true"${mine ? '' : ' hidden'}>✓</span>` +
      duelArt(artUrl, title) +
      `<span class="duel-body">` +
        `<span class="duel-side">${DUEL_SIDES[choice]}</span>` +
        `<span class="duel-name">${esc(title)}</span>` +
        `<span class="duel-pct" aria-hidden="true">${pct}%</span>` +
        `<span class="duel-bar" aria-hidden="true"><span style="width:${pct}%"></span></span>` +
        `<span class="poll-count">${n} · ${pct}%</span>` +
      `</span>` +
    `</button>`
  );
}

export function pollWidget(adaptationId, counts, total, userChoice, signedIn, art) {
  counts = counts || { book: 0, screen: 0, both: 0, undecided: 0 };
  art = art || {};
  const altBtn = (c) => {
    const n = Number(counts[c] || 0);
    const mine = userChoice === c;
    return (
      `<button type="button" class="duel-alt-btn${mine ? ' mine' : ''}" data-poll-btn="${c}" data-poll-row="${c}" ` +
      `aria-pressed="${mine ? 'true' : 'false'}">` +
        `<span>${esc(CHOICE_LABELS[c])}${mine ? ' ✓' : ''}</span>` +
        `<span class="poll-count">${n} · ${pollPct(n, total)}%</span>` +
      `</button>`
    );
  };
  return (
    `<div class="poll-widget" data-poll-widget="${adaptationId}" data-poll-signed-in="${signedIn ? '1' : '0'}">` +
      `<h2 class="section-title">Which was better?</h2>` +
      `<div class="duel" role="group" aria-label="Which was better?">` +
        duelCard('book', art.bookTitle || 'The book', art.bookCover, Number(counts.book || 0), total, userChoice) +
        `<span class="duel-vs" aria-hidden="true">vs</span>` +
        duelCard('screen', art.screenTitle || 'The screen work', art.screenPoster, Number(counts.screen || 0), total, userChoice) +
      `</div>` +
      `<div class="duel-alt" role="group" aria-label="Something else?">` +
        altBtn('both') + altBtn('undecided') +
      `</div>` +
      `<p class="meta poll-total"><span data-poll-total>${total === 1 ? '1 vote' : `${total} votes`}</span>` +
      (signedIn ? '' : ` · <a href="/auth/login">Sign in to vote</a>`) +
      `</p>` +
    `</div>`
  );
}

export function wirePolls(root) {
  root.querySelectorAll('[data-poll-widget]').forEach((w) => {
    if (w.dataset.wired) return;
    w.dataset.wired = '1';
    const adaptationId = w.dataset.pollWidget;
    const render = (data) => {
      const counts = data.counts || {};
      const total = data.total || 0;
      const mine = data.user_choice || null;
      CHOICE_ORDER.forEach((c) => {
        const row = w.querySelector(`[data-poll-row="${c}"]`);
        if (!row) return;
        const n = Number(counts[c] || 0);
        const pct = pollPct(n, total);
        const bar = row.querySelector('.duel-bar > span');
        if (bar) bar.style.width = pct + '%';
        const pctEl = row.querySelector('.duel-pct');
        if (pctEl) pctEl.textContent = pct + '%';
        const cnt = row.querySelector('.poll-count');
        if (cnt) cnt.textContent = `${n} · ${pct}%`;
        const isMine = mine === c;
        row.classList.toggle('mine', isMine);
        if (row.hasAttribute('data-poll-btn')) {
          row.setAttribute('aria-pressed', String(isMine));
          const pick = row.querySelector('.duel-pick');
          if (pick) pick.hidden = !isMine;
          if (row.classList.contains('duel-alt-btn')) {
            const lab = row.querySelector('span');
            if (lab) lab.textContent = isMine ? `${CHOICE_LABELS[c]} ✓` : CHOICE_LABELS[c];
          }
        }
      });
      const totalEl = w.querySelector('[data-poll-total]');
      if (totalEl) totalEl.textContent = total === 1 ? '1 vote' : `${total} votes`;
    };
    w.querySelectorAll('[data-poll-btn]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (w.dataset.pollSignedIn !== '1' || !store.user) {
          const { navigate } = await import('./router.js');
          navigate('/auth/login?next=' + encodeURIComponent(window.location.pathname + window.location.search));
          return;
        }
        const choice = btn.dataset.pollBtn;
        w.querySelectorAll('[data-poll-btn]').forEach((b) => { b.disabled = true; });
        try {
          const r = await api(`/api/v1/polls/${adaptationId}`, { method: 'POST', body: { choice } });
          if (!r.ok) {
            if (r.code === 'rate_limited') alert('Slow down — you get 30 poll votes per hour.');
            else if (r.status !== 401) alert(errMsg(r));
            return;
          }
          render(r.data);
        } finally {
          w.querySelectorAll('[data-poll-btn]').forEach((b) => { b.disabled = false; });
        }
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Hype meter (unreleased works only)
//
// Design: prediction-market style read-out — a big community percentage, an
// animated temperature-gradient bar (cool → hot as the score climbs), and
// count-up social proof. Voting is a single fused strip with hover/focus
// preview; your vote persists as a marker on the strip.
// ---------------------------------------------------------------------------

const HYPE_LABELS = {
  1: '1/5 — Not hyped',
  2: '2/5 — Mildly curious',
  3: '3/5 — Interested',
  4: '4/5 — Very hyped',
  5: '5/5 — Must-see day one',
};

function hypePct(average) {
  return Math.round((Math.max(0, Math.min(5, Number(average) || 0)) / 5) * 100);
}

function hypeMood(pct) {
  if (pct >= 90) return 'Off the charts';
  if (pct >= 70) return 'Running hot';
  if (pct >= 50) return 'Warming up';
  if (pct > 0) return 'Simmering';
  return 'No votes yet';
}

export function hypeWidget(screenWorkId, average, count, userLevel, signedIn) {
  const avg = Number(average || 0);
  const n = Number(count || 0);
  const pct = hypePct(avg);
  const mood = hypeMood(pct);
  const gaugeLabel = `Community hype ${pct} percent${n === 1 ? ', from 1 vote' : `, from ${n} votes`}`;
  return (
    `<section class="hype-widget" data-hype-widget data-screen-work-id="${screenWorkId}">` +
      `<div class="hype-top">` +
        `<div class="hype-score">` +
          `<strong data-hype-pct data-hype-average="${avg.toFixed(1)}">${pct}%</strong>` +
          `<span class="hype-score-meta"><span class="hype-score-label">community hype</span>` +
          `<span class="hype-mood" data-hype-mood>${esc(mood)}</span></span>` +
        `</div>` +
        `<p class="hype-count"><span data-hype-count>${n}</span> ${n === 1 ? 'vote' : 'votes'}</p>` +
      `</div>` +
      `<div class="hype-bar" data-hype-gauge role="img" aria-label="${esc(gaugeLabel)}">` +
        `<div class="hype-fill" data-hype-fill style="width:${pct}%"></div>` +
      `</div>` +
      `<div class="hype-scale" aria-hidden="true"><span>Not hyped</span><span>Must-see day one</span></div>` +
      (signedIn
        ? `<div class="hype-vote">` +
            `<span class="hype-ask">Your hype</span>` +
            `<div class="hype-strip" role="radiogroup" aria-label="Your hype level" data-hype-strip>` +
              `<div class="hype-strip-fill" data-hype-strip-fill style="width:${userLevel ? (userLevel / 5) * 100 : 0}%"></div>` +
              [1, 2, 3, 4, 5].map((level) =>
                `<button type="button" class="hype-stop${userLevel === level ? ' mine' : ''}" data-hype-level="${level}" ` +
                `aria-pressed="${userLevel === level}" aria-label="${esc(HYPE_LABELS[level])}" title="${esc(HYPE_LABELS[level])}">` +
                `<span>${level}</span></button>`
              ).join('') +
            `</div>` +
            `<p class="hype-hint" data-hype-hint>${userLevel ? `You voted ${userLevel}/5 — tap to change` : (n === 0 ? 'Be the first to vote' : 'Tap to add your vote')}</p>` +
          `</div>`
        : `<p class="hype-signin"><a href="/auth/login">Sign in</a> to vote your hype.</p>`) +
    `</section>`
  );
}

function tweenNumber(el, from, to, format, duration = 450) {
  if (from === to) { el.textContent = format(to); return; }
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = format(to); return; }
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = format(from + (to - from) * eased);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

export function wireHype(root) {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  root.querySelectorAll('[data-hype-widget]').forEach((w) => {
    if (w.dataset.wired) return;
    w.dataset.wired = '1';
    const screenWorkId = Number(w.dataset.screenWorkId);
    const gauge = w.querySelector('[data-hype-gauge]');
    const fill = w.querySelector('[data-hype-fill]');
    const pctEl = w.querySelector('[data-hype-pct]');
    const moodEl = w.querySelector('[data-hype-mood]');
    const countEl = w.querySelector('[data-hype-count]');
    const countWrap = w.querySelector('.hype-count');
    const hint = w.querySelector('[data-hype-hint]');
    const strip = w.querySelector('[data-hype-strip]');
    const stripFill = w.querySelector('[data-hype-strip-fill]');
    const stops = [...w.querySelectorAll('[data-hype-level]')];
    let level = stops.some((b) => b.classList.contains('mine'))
      ? Number(stops.find((b) => b.classList.contains('mine')).dataset.hypeLevel)
      : null;

    const render = (avg, count, newLevel) => {
      const pct = hypePct(avg);
      const prevPct = Number(pctEl?.dataset.pct ?? pct);
      if (pctEl) {
        pctEl.dataset.pct = String(pct);
        pctEl.dataset.hypeAverage = Number(avg || 0).toFixed(1);
        tweenNumber(pctEl, prevPct, pct, (v) => `${Math.round(v)}%`);
      }
      if (moodEl) moodEl.textContent = hypeMood(pct);
      if (fill) fill.style.width = `${pct}%`;
      if (gauge) {
        const n = Number(count || 0);
        gauge.setAttribute('aria-label', `Community hype ${pct} percent${n === 1 ? ', from 1 vote' : `, from ${n} votes`}`);
      }
      if (countEl) tweenNumber(countEl, Number(countEl.textContent) || 0, Number(count || 0), (v) => `${Math.round(v)}`);
      if (countWrap) {
        const nodes = [...countWrap.childNodes];
        const last = nodes[nodes.length - 1];
        if (last && last.nodeType === 3) last.textContent = ` ${Number(count) === 1 ? 'vote' : 'votes'}`;
      }
      level = newLevel;
      stops.forEach((btn) => {
        const mine = Number(btn.dataset.hypeLevel) === level;
        btn.classList.toggle('mine', mine);
        btn.setAttribute('aria-pressed', String(mine));
      });
      if (stripFill && !strip.matches(':hover') && document.activeElement?.closest('[data-hype-strip]') !== strip) {
        stripFill.style.width = `${level ? (level / 5) * 100 : 0}%`;
      }
      if (hint) hint.textContent = level ? `You voted ${level}/5 — tap to change` : 'Tap to add your vote';
    };

    // Animate the bar in on first paint.
    if (fill && !reduceMotion) {
      const target = fill.style.width;
      fill.style.width = '0%';
      requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = target; }));
    }
    if (pctEl) pctEl.dataset.pct = String(hypePct(Number(pctEl.dataset.hypeAverage) || 0));

    // Hover / focus preview on the vote strip.
    const preview = (stopLevel) => { if (stripFill) stripFill.style.width = `${(stopLevel / 5) * 100}%`; };
    const unpreview = () => { if (stripFill) stripFill.style.width = `${level ? (level / 5) * 100 : 0}%`; };
    stops.forEach((btn) => {
      const lv = Number(btn.dataset.hypeLevel);
      btn.addEventListener('mouseenter', () => preview(lv));
      btn.addEventListener('focus', () => preview(lv));
      btn.addEventListener('mouseleave', unpreview);
      btn.addEventListener('blur', unpreview);
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const r = await api('/api/v1/hype', { method: 'POST', body: { screen_work_id: screenWorkId, level: lv } });
          if (!r.ok) {
            if (r.code === 'rate_limited') alert('Slow down — hype changes are rate-limited.');
            else if (r.status !== 401) alert(errMsg(r));
            return;
          }
          render(Number(r.data.average) || 0, Number(r.data.count) || 0, lv);
        } finally {
          btn.disabled = false;
        }
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Spoiler-safe reviews
// ---------------------------------------------------------------------------

const REVIEW_TITLE_MAX = 120;
const REVIEW_BODY_MAX = 5000;

// Exported for the E2E regression suite (tests/e2e) so the spoiler
// treatment can be asserted on the real widget output. No behavior change.
export function reviewItemHtml(r, currentUserId) {
  const isAuthor = currentUserId !== null && r.author_id === currentUserId;
  const edited = r.updated_at !== r.created_at;
  const body = r.has_spoilers
    ? `<div class="spoiler-wrap">` +
        `<button type="button" class="btn btn-sm spoiler-toggle" data-spoiler-toggle aria-expanded="false">⚠️ Contains spoilers — click to reveal</button>` +
        `<div class="review-body spoiler-blurred">${esc(r.body)}</div>` +
      `</div>`
    : `<div class="review-body">${esc(r.body)}</div>`;
  return (
    `<article class="review-item" data-review-id="${r.id}">` +
      (r.title ? `<h3>${esc(r.title)}</h3>` : '') +
      `<div class="meta">by ${esc(displayName(r.author_email))} · ${esc(dateOnly(r.created_at))}` +
      (edited ? ' · edited' : '') +
      (r.has_spoilers ? `<span class="spoiler-badge">spoilers</span>` : '') +
      `</div>` +
      body +
      (isAuthor
        ? `<div class="review-actions">` +
            `<button type="button" class="btn btn-sm" data-edit-toggle="${r.id}">Edit</button>` +
            `<button type="button" class="btn btn-sm" data-delete-review="${r.id}">Delete</button>` +
          `</div>` +
          `<form class="review-edit-form" data-review-edit="${r.id}" hidden>` +
            `<label>Title (optional)<input type="text" name="title" maxlength="${REVIEW_TITLE_MAX}" value="${esc(r.title ?? '')}"></label>` +
            `<label>Review<textarea name="body" required maxlength="${REVIEW_BODY_MAX}">${esc(r.body)}</textarea></label>` +
            `<label class="checkbox-row"><input type="checkbox" name="has_spoilers"${r.has_spoilers ? ' checked' : ''}> Contains spoilers</label>` +
            `<div class="form-error" role="alert"></div>` +
            `<div class="review-actions">` +
              `<button type="submit" class="btn btn-sm btn-primary">Save changes</button>` +
              `<button type="button" class="btn btn-sm" data-edit-cancel>Cancel</button>` +
            `</div>` +
          `</form>`
        : '') +
    `</article>`
  );
}

/** Full reviews section; `refresh` re-fetches and re-renders in place (no reload). */
export function reviewsSection(targetType, targetId) {
  return (
    `<section class="reviews-section" data-reviews-section data-target-type="${esc(targetType)}" data-target-id="${targetId}" aria-label="Reviews">` +
      `<h2>Reviews</h2>` +
      `<p class="reviews-sub" data-reviews-sub></p>` +
      `<div data-reviews-form-slot></div>` +
      `<div class="review-list" data-reviews-list></div>` +
      `<div data-reviews-more style="margin-top:1rem"></div>` +
    `</section>`
  );
}

export function wireReviews(root) {
  root.querySelectorAll('[data-reviews-section]').forEach((section) => {
    if (section.dataset.wired) return;
    section.dataset.wired = '1';
    const targetType = section.dataset.targetType;
    const targetId = Number(section.dataset.targetId);
    const PER_PAGE = 10;

    const refresh = async (page = 1, append = false) => {
      const r = await api(`/api/v1/reviews?target_type=${encodeURIComponent(targetType)}&target_id=${targetId}&page=${page}&per_page=${PER_PAGE}`, { loginRedirect: false });
      if (!r.ok) {
        section.querySelector('[data-reviews-list]').innerHTML = `<p class="inline-error">${esc(errMsg(r))}</p>`;
        return;
      }
      const wrap = r.data.reviews || { data: [], total: 0, page: 1, per_page: PER_PAGE };
      const total = wrap.total || 0;
      const currentUserId = store.user ? store.user.id : null;
      const signedIn = !!store.user;

      section.querySelector('[data-reviews-sub]').innerHTML =
        esc(total === 0 ? 'Nobody has reviewed this yet.' : `${total} ${total === 1 ? 'review' : 'reviews'}`) +
        ' · Spoiler-flagged reviews stay blurred until you reveal them.';

      section.querySelector('[data-reviews-form-slot]').innerHTML = signedIn
        ? `<div class="review-form"><form data-review-form>` +
            `<label>Title (optional)<input type="text" name="title" maxlength="${REVIEW_TITLE_MAX}" placeholder="Sum it up in a line"></label>` +
            `<label>Review<textarea name="body" required maxlength="${REVIEW_BODY_MAX}" placeholder="What did you think? Flag it below if your review has spoilers."></textarea></label>` +
            `<label class="checkbox-row"><input type="checkbox" name="has_spoilers"> Contains spoilers</label>` +
            `<div class="form-error" role="alert"></div>` +
            `<div><button type="submit" class="btn btn-sm btn-primary">Post review</button></div>` +
          `</form></div>`
        : `<p class="review-signin"><a class="btn btn-sm" href="/auth/login">Sign in to write a review</a></p>`;

      const list = section.querySelector('[data-reviews-list]');
      const html = wrap.data.map((rev) => reviewItemHtml(rev, currentUserId)).join('') ||
        `<p class="review-empty">No reviews yet — be the first to write one.</p>`;
      list.innerHTML = append ? list.innerHTML + html : html;

      const moreSlot = section.querySelector('[data-reviews-more]');
      const shown = section.querySelectorAll('[data-review-id]').length;
      moreSlot.innerHTML = shown < total
        ? `<button class="btn btn-sm" data-reviews-more-btn>Load more reviews (${total - shown} remaining)</button>`
        : '';
      const moreBtn = moreSlot.querySelector('[data-reviews-more-btn]');
      if (moreBtn) moreBtn.addEventListener('click', () => refresh(page + 1, true));

      wireSectionEvents();
    };

    const wireSectionEvents = () => {
      section.querySelectorAll('[data-spoiler-toggle]').forEach((btn) => {
        if (btn.dataset.wired) return;
        btn.dataset.wired = '1';
        btn.addEventListener('click', () => {
          const body = btn.closest('.spoiler-wrap').querySelector('.review-body');
          const blurred = body.classList.toggle('spoiler-blurred');
          btn.setAttribute('aria-expanded', String(!blurred));
          btn.textContent = blurred ? '⚠️ Contains spoilers — click to reveal' : 'Hide spoilers';
        });
      });
      section.querySelectorAll('[data-edit-toggle]').forEach((btn) => {
        if (btn.dataset.wired) return;
        btn.dataset.wired = '1';
        btn.addEventListener('click', () => {
          const form = section.querySelector(`form[data-review-edit="${btn.dataset.editToggle}"]`);
          if (form) form.hidden = !form.hidden;
        });
      });
      section.querySelectorAll('[data-edit-cancel]').forEach((btn) => {
        if (btn.dataset.wired) return;
        btn.dataset.wired = '1';
        btn.addEventListener('click', () => {
          const form = btn.closest('form');
          if (form) form.hidden = true;
        });
      });
      section.querySelectorAll('form[data-review-edit]').forEach((form) => {
        if (form.dataset.wired) return;
        form.dataset.wired = '1';
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const id = form.dataset.reviewEdit;
          const fd = new FormData(form);
          const r = await api(`/api/v1/reviews/${id}`, {
            method: 'PUT',
            body: {
              title: String(fd.get('title') || ''),
              body: String(fd.get('body') || ''),
              has_spoilers: fd.get('has_spoilers') === 'on',
            },
          });
          if (!r.ok) {
            const err = form.querySelector('.form-error');
            if (err) err.textContent = errMsg(r);
            return;
          }
          refresh();
        });
      });
      section.querySelectorAll('[data-delete-review]').forEach((btn) => {
        if (btn.dataset.wired) return;
        btn.dataset.wired = '1';
        btn.addEventListener('click', async () => {
          if (!confirm('Delete this review? This cannot be undone.')) return;
          const r = await api(`/api/v1/reviews/${btn.dataset.deleteReview}`, { method: 'DELETE' });
          if (!r.ok) { alert(errMsg(r)); return; }
          refresh();
        });
      });
      const createForm = section.querySelector('form[data-review-form]');
      if (createForm && !createForm.dataset.wired) {
        createForm.dataset.wired = '1';
        createForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          const fd = new FormData(createForm);
          const body = String(fd.get('body') || '');
          if (!body.trim()) {
            createForm.querySelector('.form-error').textContent = 'Review body cannot be empty.';
            return;
          }
          const r = await api('/api/v1/reviews', {
            method: 'POST',
            body: {
              target_type: targetType,
              target_id: targetId,
              title: String(fd.get('title') || ''),
              body,
              has_spoilers: fd.get('has_spoilers') === 'on',
            },
          });
          if (!r.ok) {
            const errEl = createForm.querySelector('.form-error');
            if (r.code === 'conflict' && r.data.review_id) {
              errEl.innerHTML = `You already reviewed this — <button type="button" class="btn btn-sm" data-jump-edit="${r.data.review_id}">edit your review</button> instead.`;
              const jump = errEl.querySelector('[data-jump-edit]');
              if (jump) jump.addEventListener('click', () => {
                const target = section.querySelector(`form[data-review-edit="${r.data.review_id}"]`);
                if (target) { target.hidden = false; target.scrollIntoView({ block: 'center' }); }
              });
            } else {
              errEl.textContent = errMsg(r);
            }
            return;
          }
          refresh();
        });
      }
    };

    refresh();
  });
}

// ---------------------------------------------------------------------------
// Add to list (book / screen-work pages)
// ---------------------------------------------------------------------------

export function addToListControl(targetType, targetId, userLists, signedIn) {
  if (!signedIn) return '';
  if (!userLists || userLists.length === 0) {
    return `<span class="add-to-list"><a class="btn btn-sm" href="/lists">Create a list to save this</a></span>`;
  }
  return (
    `<span class="add-to-list" data-add-to-list data-target-type="${esc(targetType)}" data-target-id="${targetId}">` +
      `<select class="shelf-select" aria-label="Add to a list" title="Add to one of your lists">` +
        `<option value="">＋ List…</option>` +
        userLists.map((l) => `<option value="${l.id}">${esc(l.title)}</option>`).join('') +
      `</select>` +
      `<button class="btn btn-sm" type="button">Add</button>` +
      `<span class="msg" role="status"></span>` +
    `</span>`
  );
}

export function wireAddToList(root) {
  root.querySelectorAll('[data-add-to-list]').forEach((box) => {
    if (box.dataset.wired) return;
    box.dataset.wired = '1';
    const sel = box.querySelector('select');
    const btn = box.querySelector('button');
    const msg = box.querySelector('.msg');
    const say = (t) => { if (msg) msg.textContent = t; };
    btn.addEventListener('click', async () => {
      const listId = sel.value;
      if (!listId) { say('Pick a list first.'); return; }
      btn.disabled = true;
      const r = await api(`/api/v1/lists/${listId}/items`, {
        method: 'POST',
        body: { target_type: box.dataset.targetType, target_id: Number(box.dataset.targetId) },
      });
      btn.disabled = false;
      if (r.ok) {
        box.classList.add('done');
        say('Added ✓');
        return;
      }
      if (r.code === 'conflict') { say('Already on that list.'); return; }
      if (r.status !== 401) say(errMsg(r));
    });
  });
}

/** Wire every community widget under root. */
export function wireWidgets(root) {
  wireRatings(root);
  wirePolls(root);
  wireHype(root);
  wireReviews(root);
  wireAddToList(root);
}
