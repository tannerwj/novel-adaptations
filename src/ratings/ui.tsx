// src/ratings/ui.tsx — Track 1: RatingWidget, a 5-star rating control.
//
// Signed-in users get an interactive 5-star input that POSTs to /api/ratings
// and updates the displayed average/count without a reload. Logged-out users
// see a static average with a "Sign in to rate" link.
//
// Styling uses the cinematic dark-theme variables from src/ui.tsx (--gold,
// --muted, --faint, --text); the small <style> block is injected once by the
// inline script so this file doesn't touch src/ui.tsx.

import type { RatingTargetType } from './db';

export interface RatingWidgetProps {
  targetType: RatingTargetType;
  targetId: number;
  /** Average rating, 1 decimal (0 when no ratings yet). */
  average: number;
  /** Number of ratings. */
  count: number;
  /** The signed-in user's rating, or null when they haven't rated. */
  userRating: number | null;
  signedIn: boolean;
}

const WIDGET_CSS = `
.rating-widget { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; }
.rating-stars { display: inline-flex; gap: .15rem; }
.rating-stars .star {
  font-size: 1.35rem; line-height: 1; color: var(--faint);
  background: none; border: none; padding: 0 .1rem; cursor: default;
}
.rating-stars button.star { cursor: pointer; transition: transform .12s; }
.rating-stars button.star:hover { transform: scale(1.2); }
/* (keyboard focus keeps the global :focus-visible outline — never suppressed) */
.rating-stars .star.filled { color: var(--accent); }
.rating-meta { color: var(--muted); font-size: .88rem; }
.rating-average { font-weight: 700; color: var(--text); }
.rating-login { color: var(--accent-deep); font-size: .88rem; font-weight: 600; }
.rating-login:hover { color: var(--text); }
`;

/**
 * Inline, dependency-free script. Injected once per page: inserts the widget
 * CSS into <head> and wires every [data-rating-widget] on the page —
 * hover-preview, click-to-rate via fetch POST, and in-place average updates.
 */
const WIDGET_SCRIPT = `
(function () {
  if (!document.getElementById('rating-widget-css')) {
    var css = document.createElement('style');
    css.id = 'rating-widget-css';
    css.textContent = ${JSON.stringify(WIDGET_CSS)};
    document.head.appendChild(css);
  }

  function paint(stars, n) {
    for (var i = 0; i < stars.length; i++) {
      stars[i].classList.toggle('filled', i < n);
    }
  }

  document.querySelectorAll('[data-rating-widget]').forEach(function (el) {
    if (el.getAttribute('data-rating-wired') === '1') return;
    el.setAttribute('data-rating-wired', '1');
    if (el.getAttribute('data-signed-in') !== '1') return; // static display only

    var targetType = el.getAttribute('data-target-type');
    var targetId = Number(el.getAttribute('data-target-id'));
    var userRating = Number(el.getAttribute('data-user-rating') || 0);
    var stars = Array.prototype.slice.call(el.querySelectorAll('[data-rating-star]'));
    var avgEl = el.querySelector('[data-rating-average]');
    var countEl = el.querySelector('[data-rating-count]');

    function showUserRating() { paint(stars, userRating); }
    showUserRating();

    stars.forEach(function (star, i) {
      var v = i + 1;
      star.addEventListener('mouseenter', function () { paint(stars, v); });
      star.addEventListener('mouseleave', showUserRating);
      star.addEventListener('focus', function () { paint(stars, v); });
      star.addEventListener('blur', showUserRating);
      star.addEventListener('click', async function () {
        star.disabled = true;
        var res, data = {};
        try {
          res = await fetch('/api/ratings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ target_type: targetType, target_id: targetId, rating: v }),
          });
          try { data = await res.json(); } catch (e) {}
        } catch (e) {
          star.disabled = false;
          alert('Something went wrong. Please try again.');
          return;
        }
        star.disabled = false;
        if (!res.ok) {
          if (res.status === 401 || res.status === 403) { window.location.href = '/auth/login'; return; }
          if (res.status === 429) alert('Slow down — you can rate up to 60 titles per hour.');
          else alert('Something went wrong. Please try again.');
          return;
        }
        userRating = v;
        el.setAttribute('data-user-rating', String(v));
        showUserRating();
        if (avgEl && typeof data.average === 'number') avgEl.textContent = data.average.toFixed(1);
        if (countEl && typeof data.count === 'number') {
          countEl.textContent = data.count + (data.count === 1 ? ' rating' : ' ratings');
        }
      });
    });
  });
})();
`;

export function RatingWidget({
  targetType,
  targetId,
  average,
  count,
  userRating,
  signedIn,
}: RatingWidgetProps) {
  const current = signedIn ? (userRating ?? 0) : 0;
  // Static display for logged-out users: fill to the rounded average.
  const displayFilled = signedIn ? current : Math.round(average);
  const countLabel = `${count} ${count === 1 ? 'rating' : 'ratings'}`;

  return (
    <div
      class="rating-widget"
      data-rating-widget
      data-target-type={targetType}
      data-target-id={String(targetId)}
      data-signed-in={signedIn ? '1' : '0'}
      data-user-rating={String(current)}
    >
      <span class="rating-stars" role={signedIn ? 'radiogroup' : undefined} aria-label="Your rating">
        {[1, 2, 3, 4, 5].map((n) =>
          signedIn ? (
            <button
              key={n}
              type="button"
              class={`star ${n <= current ? 'filled' : ''}`}
              data-rating-star
              data-value={String(n)}
              role="radio"
              aria-checked={n === current ? 'true' : 'false'}
              aria-label={`${n} star${n === 1 ? '' : 's'}`}
              title={`Rate ${n} star${n === 1 ? '' : 's'}`}
            >
              ★
            </button>
          ) : (
            <span key={n} class={`star ${n <= displayFilled ? 'filled' : ''}`} aria-hidden="true">
              ★
            </span>
          ),
        )}
      </span>
      <span class="rating-meta">
        <span class="rating-average" data-rating-average>
          {average.toFixed(1)}
        </span>{' '}
        · <span data-rating-count>{countLabel}</span>
      </span>
      {!signedIn && (
        <a class="rating-login" href="/auth/login">
          Sign in to rate
        </a>
      )}
      <script dangerouslySetInnerHTML={{ __html: WIDGET_SCRIPT }} />
    </div>
  );
}
