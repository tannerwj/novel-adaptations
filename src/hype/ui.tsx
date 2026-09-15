/** @jsxImportSource hono/jsx */
/**
 * src/hype/ui.tsx — the hype meter widget for unreleased screen works.
 *
 * Deliberately NOT stars: this is a segmented fuel-gauge ("meter"), visually
 * distinct from Track 1 star ratings. Render ONLY for unreleased works —
 * the coordinator gates on isUnreleased(work.release_date) from './db'.
 *
 * Interaction contract (see HYPE_SCRIPT below):
 *  - buttons with [data-hype-level] POST /api/hype { screen_work_id, level },
 *    then re-render the gauge/stats in place from the JSON response.
 *  - auth rides the httpOnly session cookie (same-origin fetch); 401 sends
 *    the user to /auth/login. 429/5xx surface a plain alert.
 *  - the script is idempotent across multiple widgets per page: it marks
 *    each bound widget with [data-hype-bound] and skips re-binding.
 */

/** Human labels for each hype level (tooltips + aria). */
export const HYPE_LABELS: Record<number, string> = {
  1: '1/5 — Not hyped',
  2: '2/5 — Mildly curious',
  3: '3/5 — Interested',
  4: '4/5 — Very hyped',
  5: '5/5 — Must-see day one',
};

const HYPE_CSS = `
.hype-widget { border: 1px solid var(--border); background: var(--bg-soft); border-radius: var(--radius); padding: 1rem 1.25rem; }
.hype-title { font-family: var(--serif); font-size: 1.1rem; font-weight: 700; color: var(--text); }
.hype-gauge { display: flex; gap: 6px; margin: 0.75rem 0 0.5rem; }
.hype-cell { flex: 1 1 0; height: 14px; border-radius: 7px; background: var(--surface-2); border: 1px solid var(--border); }
.hype-cell.on { background: linear-gradient(90deg, #ff9a3c, #ff5e3a, #e5383b); border-color: transparent; }
.hype-stats { margin: 0; color: var(--muted); font-size: 0.9rem; }
.hype-stats strong { color: var(--text); font-size: 1.05rem; }
.hype-ask { margin: 0.9rem 0 0.4rem; color: var(--text); font-weight: 600; font-size: 0.95rem; }
.hype-segs { display: flex; gap: 6px; }
.hype-seg { flex: 1 1 0; appearance: none; cursor: pointer; border: 1px solid var(--border); background: var(--surface); color: var(--muted); border-radius: 10px; padding: 0.55rem 0 0.45rem; font: inherit; font-size: 0.85rem; font-weight: 700; }
.hype-seg:hover { border-color: #ff9a3c; color: var(--text); }
.hype-seg.mine { background: linear-gradient(180deg, rgba(255,154,60,.28), rgba(229,56,59,.28)); border-color: #ff9a3c; color: var(--text); }
.hype-seg:disabled { opacity: 0.6; cursor: wait; }
.hype-hint { margin: 0.5rem 0 0; color: var(--faint); font-size: 0.8rem; }
.hype-signin { margin: 0.9rem 0 0; color: var(--muted); font-size: 0.9rem; }
.hype-signin a { color: var(--link); }
`;

/**
 * HYPE_SCRIPT wires [data-hype-level] buttons inside each [data-hype-widget]:
 * POST /api/hype, then update the gauge, stats, and "mine" state in place.
 */
const HYPE_SCRIPT = `
(function () {
  document.querySelectorAll('[data-hype-widget]:not([data-hype-bound])').forEach(function (w) {
    w.setAttribute('data-hype-bound', '1');
    var screenWorkId = Number(w.getAttribute('data-screen-work-id'));
    var gauge = w.querySelector('[data-hype-gauge]');
    var avgEl = w.querySelector('[data-hype-average]');
    var countEl = w.querySelector('[data-hype-count]');
    var hint = w.querySelector('[data-hype-hint]');
    function render(avg, count, level) {
      var full = Math.round(avg);
      if (gauge) {
        var cells = gauge.querySelectorAll('.hype-cell');
        for (var i = 0; i < cells.length; i++) cells[i].classList.toggle('on', i < full);
        gauge.setAttribute('aria-label', 'Average hype ' + avg.toFixed(1) + ' out of 5 from ' + count + ' ratings');
      }
      if (avgEl) avgEl.textContent = avg.toFixed(1);
      if (countEl) countEl.textContent = String(count);
      w.querySelectorAll('[data-hype-level]').forEach(function (btn) {
        var mine = Number(btn.getAttribute('data-hype-level')) === level;
        btn.classList.toggle('mine', mine);
        btn.setAttribute('aria-pressed', String(mine));
      });
      if (hint) hint.textContent = level ? ('You are at ' + level + '/5 — tap to change') : 'Tap a segment to set your hype';
    }
    w.querySelectorAll('[data-hype-level]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var level = Number(btn.getAttribute('data-hype-level'));
        btn.disabled = true;
        try {
          var res = await fetch('/api/hype', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ screen_work_id: screenWorkId, level: level })
          });
          var data = {};
          try { data = await res.json(); } catch (e) {}
          if (res.status === 401) { window.location.href = '/auth/login'; return; }
          if (res.status === 429) { alert('Slow down — hype changes are rate-limited.'); return; }
          if (!res.ok) { alert('Error: ' + (data.error || res.status)); return; }
          render(Number(data.average) || 0, Number(data.count) || 0, level);
        } finally {
          btn.disabled = false;
        }
      });
    });
  });
})();
`;

export function HypeWidget({
  screenWorkId,
  average,
  count,
  userLevel,
  signedIn,
}: {
  screenWorkId: number;
  average: number;
  count: number;
  userLevel: number | null;
  signedIn: boolean;
}) {
  const filled = Math.max(0, Math.min(5, Math.round(average)));
  return (
    <section class="hype-widget" data-hype-widget data-screen-work-id={String(screenWorkId)}>
      <style dangerouslySetInnerHTML={{ __html: HYPE_CSS }} />
      <div class="hype-title">🔥 Hype meter</div>
      <div
        class="hype-gauge"
        data-hype-gauge
        role="img"
        aria-label={`Average hype ${average.toFixed(1)} out of 5 from ${count} ratings`}
      >
        {[0, 1, 2, 3, 4].map((i) => (
          <span class={`hype-cell${i < filled ? ' on' : ''}`} key={i} />
        ))}
      </div>
      <p class="hype-stats">
        <strong data-hype-average>{average.toFixed(1)}</strong>/5 ·{' '}
        <span data-hype-count>{count}</span> hyped
      </p>
      {signedIn ? (
        <>
          <p class="hype-ask">How hyped are you?</p>
          <div class="hype-segs" role="radiogroup" aria-label="Your hype level">
            {[1, 2, 3, 4, 5].map((level) => (
              <button
                type="button"
                class="hype-seg"
                data-hype-level={String(level)}
                aria-pressed={userLevel === level}
                aria-label={HYPE_LABELS[level]}
                title={HYPE_LABELS[level]}
                key={level}
              >
                {userLevel === level ? '● ' : ''}
                {level}
              </button>
            ))}
          </div>
          <p class="hype-hint" data-hype-hint>
            {userLevel
              ? `You are at ${userLevel}/5 — tap to change`
              : 'Tap a segment to set your hype'}
          </p>
        </>
      ) : (
        <p class="hype-signin">
          <a href="/auth/login">Sign in</a> to add your hype.
        </p>
      )}
      <script dangerouslySetInnerHTML={{ __html: HYPE_SCRIPT }} />
    </section>
  );
}
