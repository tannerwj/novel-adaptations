/** @jsxImportSource hono/jsx */
/**
 * src/polls/ui.tsx — Track 3: the "Which was better?" poll widget.
 *
 * Server-rendered with live result bars; votes post to /api/polls/:id and
 * update in place via the inline POLL_SCRIPT (dependency-free vanilla JS,
 * same pattern as the vote/shelf USER_SCRIPT in src/ui.tsx).
 *
 * Styles are self-contained (.poll-*) and reuse the theme CSS variables
 * (--gold, --muted, --serif) from src/ui.tsx's GLOBAL_CSS so the widget
 * matches the cinematic dark theme without touching that file.
 */

import type { PollChoice, PollResults } from './db';

const CHOICE_LABELS: Record<PollChoice, string> = {
  book: 'Book',
  screen: 'Screen',
  both: 'Both great',
  undecided: 'Undecided',
};

const CHOICE_ORDER: PollChoice[] = ['book', 'screen', 'both', 'undecided'];

export interface PollWidgetProps extends PollResults {
  adaptationId: number;
  userChoice: PollChoice | null;
  /** False → show results with a "Sign in to vote" link instead of buttons. */
  signedIn: boolean;
}

function pct(count: number, total: number): number {
  return total > 0 ? Math.round((count / total) * 100) : 0;
}

const POLL_CSS = `
.poll-widget { margin: 0; }
.poll-options { display: grid; grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr)); gap: .5rem; margin: 1rem 0 1.25rem; }
.poll-btn { appearance: none; cursor: pointer; font: 600 .85rem var(--sans, system-ui, sans-serif); padding: .55rem .5rem; border-radius: .5rem; border: 1px solid rgba(255,255,255,.16); background: rgba(255,255,255,.04); color: inherit; transition: border-color .15s, transform .1s; }
.poll-btn:hover { border-color: var(--gold, #c9a227); }
.poll-btn:active { transform: scale(.97); }
.poll-btn.mine { border-color: var(--gold, #c9a227); box-shadow: 0 0 0 1px var(--gold, #c9a227) inset; }
.poll-btn[disabled] { opacity: .55; cursor: wait; }
.poll-results { display: grid; gap: .6rem; }
.poll-row { display: grid; grid-template-columns: 6.5rem 1fr auto; align-items: center; gap: .6rem; font-size: .85rem; }
.poll-row .poll-label { color: var(--muted, #a09a8c); white-space: nowrap; }
.poll-row.mine .poll-label { color: inherit; font-weight: 700; }
.poll-bar { height: .45rem; border-radius: 999px; background: rgba(255,255,255,.08); overflow: hidden; }
.poll-bar > span { display: block; height: 100%; border-radius: 999px; background: var(--gold, #c9a227); opacity: .75; transition: width .3s ease; }
.poll-row.mine .poll-bar > span { opacity: 1; }
.poll-count { color: var(--muted, #a09a8c); font-variant-numeric: tabular-nums; white-space: nowrap; }
.poll-total { margin-top: .9rem; }
`;

const POLL_SCRIPT = `
(function () {
  document.querySelectorAll('[data-poll-widget]').forEach(function (root) {
    var adaptationId = root.getAttribute('data-poll-widget');
    var ORDER = ['book', 'screen', 'both', 'undecided'];
    function reqJson(path, opts) {
      var init = { headers: { 'Content-Type': 'application/json' } };
      if (opts) for (var k in opts) init[k] = opts[k];
      return fetch(path, init).then(function (res) {
        return res.json().then(function (data) {
          return { ok: res.ok, status: res.status, data: data || {} };
        }).catch(function () { return { ok: res.ok, status: res.status, data: {} }; });
      });
    }
    function render(data) {
      var counts = data.counts || {}, total = data.total || 0, mine = data.userChoice || null;
      ORDER.forEach(function (choice) {
        var row = root.querySelector('[data-poll-row="' + choice + '"]');
        if (!row) return;
        var n = Number(counts[choice] || 0);
        var percent = total > 0 ? Math.round(n / total * 100) : 0;
        var bar = row.querySelector('.poll-bar > span');
        var count = row.querySelector('.poll-count');
        if (bar) bar.style.width = percent + '%';
        if (count) count.textContent = n + ' · ' + percent + '%';
        row.classList.toggle('mine', mine === choice);
      });
      var totalEl = root.querySelector('[data-poll-total]');
      if (totalEl) totalEl.textContent = total === 1 ? '1 vote' : total + ' votes';
      root.querySelectorAll('[data-poll-btn]').forEach(function (b) {
        b.classList.toggle('mine', b.getAttribute('data-poll-btn') === mine);
      });
    }
    root.querySelectorAll('[data-poll-btn]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        if (root.getAttribute('data-poll-signed-in') !== '1') { window.location.href = '/auth/login'; return; }
        var choice = btn.getAttribute('data-poll-btn');
        root.querySelectorAll('[data-poll-btn]').forEach(function (b) { b.disabled = true; });
        try {
          var r = await reqJson('/api/polls/' + adaptationId, { method: 'POST', body: JSON.stringify({ choice: choice }) });
          if (!r.ok) {
            if (r.status === 401) { window.location.href = '/auth/login'; return; }
            if (r.status === 429) alert('Slow down — you get 30 poll votes per hour.');
            else alert('Something went wrong. Please try again.');
            return;
          }
          render(r.data);
        } catch (e) {
          alert('Something went wrong. Please try again.');
        } finally {
          root.querySelectorAll('[data-poll-btn]').forEach(function (b) { b.disabled = false; });
        }
      });
    });
  });
})();
`;

/**
 * The book-vs-screen poll widget. Rendered inside a `.panel` on the
 * adaptation page. Server-rendered from fresh `getPollResults` +
 * `getUserChoice` data; the inline script keeps it live after voting.
 */
export function PollWidget({
  adaptationId,
  counts,
  total,
  userChoice,
  signedIn,
}: PollWidgetProps) {
  return (
    <div data-poll-widget={String(adaptationId)} data-poll-signed-in={signedIn ? '1' : '0'}>
      <style>{POLL_CSS}</style>
      <h2 class="section-title">Which was better?</h2>
      <div class="poll-options" role="group" aria-label="Which was better?">
        {CHOICE_ORDER.map((choice) => (
          <button
            type="button"
            class={`poll-btn${userChoice === choice ? ' mine' : ''}`}
            data-poll-btn={choice}
            aria-pressed={userChoice === choice ? 'true' : 'false'}
          >
            {CHOICE_LABELS[choice]}
            {userChoice === choice ? ' ✓' : ''}
          </button>
        ))}
      </div>
      <div class="poll-results" aria-live="polite">
        {CHOICE_ORDER.map((choice) => (
          <div class={`poll-row${userChoice === choice ? ' mine' : ''}`} data-poll-row={choice}>
            <span class="poll-label">
              {CHOICE_LABELS[choice]}
              {userChoice === choice ? ' ✓' : ''}
            </span>
            <div class="poll-bar">
              <span style={`width:${pct(counts[choice], total)}%`}></span>
            </div>
            <span class="poll-count">
              {counts[choice]} · {pct(counts[choice], total)}%
            </span>
          </div>
        ))}
      </div>
      <p class="meta poll-total">
        <span data-poll-total>{total === 1 ? '1 vote' : `${total} votes`}</span>
        {!signedIn && (
          <>
            {' '}· <a href="/auth/login">Sign in to vote</a>
          </>
        )}
      </p>
      <script dangerouslySetInnerHTML={{ __html: POLL_SCRIPT }} />
    </div>
  );
}
