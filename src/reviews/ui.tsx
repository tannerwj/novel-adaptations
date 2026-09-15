/** @jsxImportSource hono/jsx */
/**
 * src/reviews/ui.tsx — Track 2: spoiler-safe review UI.
 *
 * Server-rendered Hono JSX, cinematic dark theme (class conventions match
 * src/ui.tsx: .btn/.btn-sm/.btn-primary, --surface/--border/--muted vars).
 * Interactions are dependency-free vanilla JS (REVIEW_SCRIPT), following the
 * vote/shelf button pattern in src/ui.tsx's USER_SCRIPT.
 *
 * Review bodies are user content: rendered through JSX auto-escaping only
 * (never dangerouslySetInnerHTML), line breaks preserved with
 * `white-space: pre-wrap`.
 */
import type { Review, ReviewTargetType } from './db';
import { BODY_MAX, TITLE_MAX } from './routes';

export type ReviewView = Review;

/**
 * Scoped stylesheet for the review components. The coordinator should either
 * append this to the page <head> or (simplest) let ReviewList emit it via
 * <style> on render — ReviewList includes it inline so no ui.tsx edit is
 * needed.
 */
export const REVIEW_CSS = `
.reviews-section { margin-top: 2.5rem; }
.reviews-section h2 { font-family: var(--serif); font-size: 1.5rem; margin: 0 0 .4rem; }
.reviews-section .reviews-sub { color: var(--muted); font-size: .9rem; margin: 0 0 1.25rem; }
.review-list { display: grid; gap: 1rem; margin-top: 1.5rem; }
.review-empty { color: var(--faint); font-size: .95rem; padding: 1rem 0; }
.review-item {
  border: 1px solid var(--border); border-radius: var(--radius);
  padding: 1.25rem 1.4rem; background: var(--surface);
}
.review-item h3 { margin: 0 0 .35rem; font-size: 1.08rem; line-height: 1.35; }
.review-item .meta { color: var(--muted); font-size: .82rem; margin-bottom: .7rem; }
.review-body { white-space: pre-wrap; font-size: .95rem; color: var(--text); line-height: 1.65; }
.review-body.spoiler-blurred { filter: blur(6px); user-select: none; pointer-events: none; }
.spoiler-toggle { margin-bottom: .7rem; }
.spoiler-badge {
  display: inline-block; font-size: .72rem; text-transform: uppercase; letter-spacing: .1em;
  color: var(--accent-deep); border: 1px solid var(--accent); border-radius: 999px;
  padding: .15rem .6rem; margin-left: .6rem; vertical-align: middle;
}
.review-actions { display: flex; gap: .5rem; margin-top: .9rem; }
.review-edit-form { display: grid; gap: .8rem; margin-top: 1rem; }
.review-edit-form[hidden] { display: none; }
.review-form { margin-bottom: 1.5rem; }
.review-form label, .review-edit-form label {
  font-size: .85rem; font-weight: 600; color: var(--muted); display: grid; gap: .4rem;
}
.review-form input[type="text"], .review-form textarea,
.review-edit-form input[type="text"], .review-edit-form textarea {
  font: inherit; padding: .7rem 1rem; border-radius: 10px;
  border: 1px solid var(--border); background: var(--bg-soft); color: var(--text);
  width: 100%; box-sizing: border-box;
}
.review-form textarea, .review-edit-form textarea { min-height: 7rem; resize: vertical; }
.review-form .checkbox-row, .review-edit-form .checkbox-row {
  display: flex; gap: .5rem; align-items: center; font-weight: 400;
}
.review-form .checkbox-row input, .review-edit-form .checkbox-row input { width: auto; }
.review-form .form-error, .review-edit-form .form-error { color: var(--danger); font-size: .85rem; }
.review-signin { margin-bottom: 1.5rem; }
`;

/**
 * Vanilla JS — reviews (dependency-free, no framework).
 *  - [data-spoiler-toggle]: toggles the blur on its sibling .review-body.
 *  - [data-edit-toggle]: shows/hides the inline edit form for that review.
 *  - form[data-review-edit]: PUT /api/reviews/:id, reload on success.
 *  - [data-delete-review]: confirm → DELETE /api/reviews/:id, reload.
 *  - form[data-review-form]: POST /api/reviews, reload on success.
 * 409 on create (already reviewed) tells the user to edit instead.
 */
export const REVIEW_SCRIPT = `
(function () {
  function bad(res, form) {
    var err = form ? form.querySelector('.form-error') : null;
    if (res.status === 401 || res.status === 403) { window.location.href = '/auth/login'; return true; }
    var msg = res.data && res.data.error ? res.data.error : 'Something went wrong. Please try again.';
    if (err) { err.textContent = msg; } else { alert(msg); }
    return true;
  }
  async function reqJson(path, opts) {
    var init = { headers: { 'Content-Type': 'application/json' } };
    if (opts) for (var k in opts) init[k] = opts[k];
    const res = await fetch(path, init);
    let data = {};
    try { data = await res.json(); } catch (e) {}
    return { ok: res.ok, status: res.status, data: data };
  }

  document.querySelectorAll('[data-spoiler-toggle]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var body = btn.closest('.spoiler-wrap').querySelector('.review-body');
      var blurred = body.classList.toggle('spoiler-blurred');
      btn.setAttribute('aria-expanded', String(!blurred));
      btn.textContent = blurred ? '\\u26A0\\uFE0F Contains spoilers \\u2014 click to reveal' : 'Hide spoilers';
    });
  });

  document.querySelectorAll('[data-edit-toggle]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var form = document.querySelector('form[data-review-edit="' + btn.getAttribute('data-edit-toggle') + '"]');
      if (form) form.hidden = !form.hidden;
    });
  });

  document.querySelectorAll('[data-edit-cancel]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var form = btn.closest('form');
      if (form) form.hidden = true;
    });
  });

  document.querySelectorAll('form[data-review-edit]').forEach(function (form) {
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var id = form.getAttribute('data-review-edit');
      var fd = new FormData(form);
      var body = {
        title: String(fd.get('title') || ''),
        body: String(fd.get('body') || ''),
        has_spoilers: fd.get('has_spoilers') === 'on'
      };
      var r = await reqJson('/api/reviews/' + id, { method: 'PUT', body: JSON.stringify(body) });
      if (!r.ok) { bad(r, form); return; }
      location.reload();
    });
  });

  document.querySelectorAll('[data-delete-review]').forEach(function (btn) {
    btn.addEventListener('click', async function () {
      if (!confirm('Delete this review? This cannot be undone.')) return;
      var id = btn.getAttribute('data-delete-review');
      var r = await reqJson('/api/reviews/' + id, { method: 'DELETE' });
      if (!r.ok) { bad(r, null); return; }
      location.reload();
    });
  });

  document.querySelectorAll('form[data-review-form]').forEach(function (form) {
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var fd = new FormData(form);
      var body = {
        target_type: form.getAttribute('data-target-type'),
        target_id: Number(form.getAttribute('data-target-id')),
        title: String(fd.get('title') || ''),
        body: String(fd.get('body') || ''),
        has_spoilers: fd.get('has_spoilers') === 'on'
      };
      if (!body.body.trim()) {
        var err = form.querySelector('.form-error');
        if (err) err.textContent = 'Review body cannot be empty.';
        return;
      }
      var r = await reqJson('/api/reviews', { method: 'POST', body: JSON.stringify(body) });
      if (!r.ok) { bad(r, form); return; }
      location.reload();
    });
  });
})();
`;

/** Public display name for a reviewer — the email's local part, no full address. */
function displayName(email: string): string {
  return email.split('@')[0] || 'reader';
}

function formatDate(createdAt: string): string {
  return createdAt.slice(0, 10);
}

/** One review: title, auto-escaped body (pre-wrap), author, date, spoiler blur. */
function ReviewItem({
  review,
  currentUserId,
}: {
  review: ReviewView;
  currentUserId: number | null;
}) {
  const isAuthor = currentUserId !== null && review.authorId === currentUserId;
  const edited = review.updatedAt !== review.createdAt;
  return (
    <article class="review-item">
      {review.title && <h3>{review.title}</h3>}
      <div class="meta">
        by {displayName(review.authorEmail)} · {formatDate(review.createdAt)}
        {edited && ' · edited'}
        {review.hasSpoilers && <span class="spoiler-badge">spoilers</span>}
      </div>
      {review.hasSpoilers ? (
        <div class="spoiler-wrap">
          <button
            type="button"
            class="btn btn-sm spoiler-toggle"
            data-spoiler-toggle
            aria-expanded="false"
          >
            ⚠️ Contains spoilers — click to reveal
          </button>
          <div class="review-body spoiler-blurred">{review.body}</div>
        </div>
      ) : (
        <div class="review-body">{review.body}</div>
      )}
      {isAuthor && (
        <div class="review-actions">
          <button
            type="button"
            class="btn btn-sm"
            data-edit-toggle={String(review.id)}
          >
            Edit
          </button>
          <button
            type="button"
            class="btn btn-sm"
            data-delete-review={String(review.id)}
          >
            Delete
          </button>
        </div>
      )}
      {isAuthor && (
        <form class="review-edit-form" data-review-edit={String(review.id)} hidden>
          <label>
            Title (optional)
            <input
              type="text"
              name="title"
              maxlength={TITLE_MAX}
              value={review.title ?? ''}
            />
          </label>
          <label>
            Review
            <textarea name="body" required maxlength={BODY_MAX}>{review.body}</textarea>
          </label>
          <label class="checkbox-row">
            <input
              type="checkbox"
              name="has_spoilers"
              checked={review.hasSpoilers}
            />
            Contains spoilers
          </label>
          <div class="form-error" role="alert" />
          <div class="review-actions">
            <button type="submit" class="btn btn-sm btn-primary">
              Save changes
            </button>
            <button type="button" class="btn btn-sm" data-edit-cancel>
              Cancel
            </button>
          </div>
        </form>
      )}
    </article>
  );
}

/** Newest-first list of reviews. Author sees Edit/Delete on their own. */
export function ReviewList({
  reviews,
  currentUserId,
}: {
  reviews: ReviewView[];
  currentUserId: number | null;
}) {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: REVIEW_CSS }} />
      <div class="review-list">
        {reviews.length === 0 && (
          <p class="review-empty">No reviews yet — be the first to share your take.</p>
        )}
        {reviews.map((r) => (
          <ReviewItem review={r} currentUserId={currentUserId} />
        ))}
      </div>
      <script dangerouslySetInnerHTML={{ __html: REVIEW_SCRIPT }} />
    </>
  );
}

/**
 * Write-a-review form for a target. Signed-out users get the "Sign in to
 * write a review" link instead of the form.
 */
export function ReviewForm({
  targetType,
  targetId,
  signedIn,
}: {
  targetType: ReviewTargetType;
  targetId: number;
  signedIn: boolean;
}) {
  if (!signedIn) {
    return (
      <p class="review-signin">
        <a class="btn btn-sm" href="/auth/login">
          Sign in to write a review
        </a>
      </p>
    );
  }
  return (
    <div class="review-form">
      <form data-review-form data-target-type={targetType} data-target-id={String(targetId)}>
        <label>
          Title (optional)
          <input
            type="text"
            name="title"
            maxlength={TITLE_MAX}
            placeholder="Sum it up in a line"
          />
        </label>
        <label>
          Review
          <textarea
            name="body"
            required
            maxlength={BODY_MAX}
            placeholder="What did you think? No spoilers outside the spoiler flag…"
          />
        </label>
        <label class="checkbox-row">
          <input type="checkbox" name="has_spoilers" />
          Contains spoilers
        </label>
        <div class="form-error" role="alert" />
        <div>
          <button type="submit" class="btn btn-sm btn-primary">
            Post review
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * Convenience wrapper for detail pages: heading + form + list.
 * targetType is 'book' for /books/:id, 'screen_work' for /watch/:id.
 */
export function ReviewsSection({
  targetType,
  targetId,
  reviews,
  currentUserId,
}: {
  targetType: ReviewTargetType;
  targetId: number;
  reviews: ReviewView[];
  currentUserId: number | null;
}) {
  return (
    <section class="reviews-section" aria-label="Reviews">
      <h2>Reviews</h2>
      <p class="reviews-sub">
        {reviews.length === 0
          ? 'Nobody has reviewed this yet.'
          : `${reviews.length} ${reviews.length === 1 ? 'review' : 'reviews'}`}
        {' · '}Spoiler-flagged reviews stay blurred until you reveal them.
      </p>
      <ReviewForm
        targetType={targetType}
        targetId={targetId}
        signedIn={currentUserId !== null}
      />
      <ReviewList reviews={reviews} currentUserId={currentUserId} />
    </section>
  );
}
