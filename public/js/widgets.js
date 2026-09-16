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
// Book-vs-screen poll
// ---------------------------------------------------------------------------

const CHOICE_LABELS = { book: 'Book', screen: 'Screen', both: 'Both great', undecided: 'Undecided' };
const CHOICE_ORDER = ['book', 'screen', 'both', 'undecided'];

function pollPct(n, total) {
  return total > 0 ? Math.round((n / total) * 100) : 0;
}

export function pollWidget(adaptationId, counts, total, userChoice, signedIn) {
  counts = counts || { book: 0, screen: 0, both: 0, undecided: 0 };
  return (
    `<div class="poll-widget" data-poll-widget="${adaptationId}" data-poll-signed-in="${signedIn ? '1' : '0'}">` +
      `<h2 class="section-title">Which was better?</h2>` +
      `<div class="poll-options" role="group" aria-label="Which was better?">` +
      CHOICE_ORDER.map((c) =>
        `<button type="button" class="poll-btn${userChoice === c ? ' mine' : ''}" data-poll-btn="${c}" aria-pressed="${userChoice === c ? 'true' : 'false'}">` +
        `${esc(CHOICE_LABELS[c])}${userChoice === c ? ' ✓' : ''}</button>`
      ).join('') +
      `</div>` +
      `<div class="poll-results" aria-live="polite">` +
      CHOICE_ORDER.map((c) => {
        const n = Number(counts[c] || 0);
        return (
          `<div class="poll-row${userChoice === c ? ' mine' : ''}" data-poll-row="${c}">` +
            `<span class="poll-label">${esc(CHOICE_LABELS[c])}${userChoice === c ? ' ✓' : ''}</span>` +
            `<div class="poll-bar"><span style="width:${pollPct(n, total)}%"></span></div>` +
            `<span class="poll-count">${n} · ${pollPct(n, total)}%</span>` +
          `</div>`
        );
      }).join('') +
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
        const bar = row.querySelector('.poll-bar > span');
        const cnt = row.querySelector('.poll-count');
        if (bar) bar.style.width = pct + '%';
        if (cnt) cnt.textContent = `${n} · ${pct}%`;
        row.classList.toggle('mine', mine === c);
      });
      const totalEl = w.querySelector('[data-poll-total]');
      if (totalEl) totalEl.textContent = total === 1 ? '1 vote' : `${total} votes`;
      w.querySelectorAll('[data-poll-btn]').forEach((b) => {
        const isMine = b.dataset.pollBtn === mine;
        b.classList.toggle('mine', isMine);
        b.setAttribute('aria-pressed', String(isMine));
      });
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
// ---------------------------------------------------------------------------

const HYPE_LABELS = {
  1: '1/5 — Not hyped',
  2: '2/5 — Mildly curious',
  3: '3/5 — Interested',
  4: '4/5 — Very hyped',
  5: '5/5 — Must-see day one',
};

export function hypeWidget(screenWorkId, average, count, userLevel, signedIn) {
  const filled = Math.max(0, Math.min(5, Math.round(average || 0)));
  return (
    `<section class="hype-widget" data-hype-widget data-screen-work-id="${screenWorkId}">` +
      `<div class="hype-title">🔥 Hype meter</div>` +
      `<div class="hype-gauge" data-hype-gauge role="img" aria-label="Average hype ${Number(average || 0).toFixed(1)} out of 5 from ${count} ratings">` +
      [0, 1, 2, 3, 4].map((i) => `<span class="hype-cell${i < filled ? ' on' : ''}"></span>`).join('') +
      `</div>` +
      `<p class="hype-stats"><strong data-hype-average>${Number(average || 0).toFixed(1)}</strong>/5 · <span data-hype-count>${count}</span> hyped</p>` +
      (signedIn
        ? `<p class="hype-ask">How hyped are you?</p>` +
          `<div class="hype-segs" role="radiogroup" aria-label="Your hype level">` +
          [1, 2, 3, 4, 5].map((level) =>
            `<button type="button" class="hype-seg${userLevel === level ? ' mine' : ''}" data-hype-level="${level}" ` +
            `aria-pressed="${userLevel === level}" aria-label="${esc(HYPE_LABELS[level])}" title="${esc(HYPE_LABELS[level])}">` +
            `${userLevel === level ? '● ' : ''}${level}</button>`
          ).join('') +
          `</div>` +
          `<p class="hype-hint" data-hype-hint>${userLevel ? `You are at ${userLevel}/5 — tap to change` : 'Tap a segment to set your hype'}</p>`
        : `<p class="hype-signin"><a href="/auth/login">Sign in</a> to add your hype.</p>`) +
    `</section>`
  );
}

export function wireHype(root) {
  root.querySelectorAll('[data-hype-widget]').forEach((w) => {
    if (w.dataset.wired) return;
    w.dataset.wired = '1';
    const screenWorkId = Number(w.dataset.screenWorkId);
    const gauge = w.querySelector('[data-hype-gauge]');
    const avgEl = w.querySelector('[data-hype-average]');
    const countEl = w.querySelector('[data-hype-count]');
    const hint = w.querySelector('[data-hype-hint]');
    const render = (avg, count, level) => {
      const full = Math.max(0, Math.min(5, Math.round(avg)));
      if (gauge) {
        gauge.querySelectorAll('.hype-cell').forEach((cell, i) => cell.classList.toggle('on', i < full));
        gauge.setAttribute('aria-label', `Average hype ${avg.toFixed(1)} out of 5 from ${count} ratings`);
      }
      if (avgEl) avgEl.textContent = avg.toFixed(1);
      if (countEl) countEl.textContent = String(count);
      w.querySelectorAll('[data-hype-level]').forEach((btn) => {
        const mine = Number(btn.dataset.hypeLevel) === level;
        btn.classList.toggle('mine', mine);
        btn.setAttribute('aria-pressed', String(mine));
        btn.innerHTML = `${mine ? '● ' : ''}${btn.dataset.hypeLevel}`;
      });
      if (hint) hint.textContent = level ? `You are at ${level}/5 — tap to change` : 'Tap a segment to set your hype';
    };
    w.querySelectorAll('[data-hype-level]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const level = Number(btn.dataset.hypeLevel);
        btn.disabled = true;
        try {
          const r = await api('/api/v1/hype', { method: 'POST', body: { screen_work_id: screenWorkId, level } });
          if (!r.ok) {
            if (r.code === 'rate_limited') alert('Slow down — hype changes are rate-limited.');
            else if (r.status !== 401) alert(errMsg(r));
            return;
          }
          render(Number(r.data.average) || 0, Number(r.data.count) || 0, level);
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
            `<label>Review<textarea name="body" required maxlength="${REVIEW_BODY_MAX}" placeholder="What did you think? No spoilers outside the spoiler flag…"></textarea></label>` +
            `<label class="checkbox-row"><input type="checkbox" name="has_spoilers"> Contains spoilers</label>` +
            `<div class="form-error" role="alert"></div>` +
            `<div><button type="submit" class="btn btn-sm btn-primary">Post review</button></div>` +
          `</form></div>`
        : `<p class="review-signin"><a class="btn btn-sm" href="/auth/login">Sign in to write a review</a></p>`;

      const list = section.querySelector('[data-reviews-list]');
      const html = wrap.data.map((rev) => reviewItemHtml(rev, currentUserId)).join('') ||
        `<p class="review-empty">No reviews yet — be the first to share your take.</p>`;
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
