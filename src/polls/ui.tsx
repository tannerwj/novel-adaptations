/** @jsxImportSource hono/jsx */
/**
 * src/polls/ui.tsx — Track 3: the "Which was better?" poll widget.
 *
 * Server-rendered book-vs-screen duel: two tappable cards (Book vs Screen)
 * with cover/poster art, animated percentage bars, live voter counts, and a
 * clearly marked voted state. "Both great" / "Undecided" stay available as
 * secondary options. Votes post to /api/polls/:id and update in place via the
 * inline POLL_SCRIPT (dependency-free vanilla JS, same pattern as the
 * vote/shelf USER_SCRIPT in src/ui.tsx).
 *
 * The API contract is unchanged: GET /api/polls/:id returns
 * {counts, total, userChoice}; POST /api/polls/:id accepts {choice}.
 *
 * Styles are self-contained (.poll-widget / .duel-*) and reuse the theme CSS
 * variables (--accent, --muted, --serif) from src/ui.tsx's GLOBAL_CSS so the
 * widget matches the site theme without touching that file.
 */

import type { PollChoice, PollResults } from './db';

const CHOICE_LABELS: Record<PollChoice, string> = {
  book: 'Book',
  screen: 'Screen',
  both: 'Both great',
  undecided: 'Undecided',
};

const CHOICE_ORDER: PollChoice[] = ['book', 'screen', 'both', 'undecided'];

export interface PollArt {
  bookCoverUrl: string | null;
  bookTitle: string;
  screenPosterUrl: string | null;
  screenTitle: string;
}

export interface PollWidgetProps extends PollResults {
  adaptationId: number;
  userChoice: PollChoice | null;
  /** False → show results with a "Sign in to vote" link instead of buttons. */
  signedIn: boolean;
  art: PollArt;
}

function pct(count: number, total: number): number {
  return total > 0 ? Math.round((count / total) * 100) : 0;
}

const POLL_CSS = `
.poll-widget { margin: 0; }
.duel { display: grid; grid-template-columns: 1fr auto 1fr; gap: .75rem; align-items: stretch; margin: 1.1rem 0 .9rem; }
.duel-card {
  position: relative; appearance: none; cursor: pointer; text-align: left; font: inherit; color: inherit;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
  padding: .9rem; display: grid; grid-template-columns: 64px 1fr; gap: .9rem; align-items: center;
  transition: border-color .15s, transform .12s, box-shadow .15s;
}
.duel-card:hover { border-color: var(--accent); transform: translateY(-2px); box-shadow: 0 6px 18px rgba(0,0,0,.08); }
.duel-card:active { transform: scale(.98); }
.duel-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.duel-card.mine { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset, 0 6px 20px rgba(199,143,46,.22); }
.duel-card[disabled] { opacity: .55; cursor: wait; }
.duel-art {
  width: 64px; aspect-ratio: 2 / 3; border-radius: .45rem; overflow: hidden; flex: none;
  background: var(--surface-2); border: 1px solid var(--border);
  display: flex; align-items: center; justify-content: center;
  font-family: var(--serif); font-size: 1.7rem; font-weight: 700; color: var(--faint);
}
.duel-art img { width: 100%; height: 100%; object-fit: cover; display: block; }
.duel-body { display: grid; gap: .3rem; min-width: 0; }
.duel-side { font-size: .7rem; text-transform: uppercase; letter-spacing: .09em; color: var(--faint); font-weight: 700; }
.duel-name { font-family: var(--serif); font-weight: 700; font-size: 1.05rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.duel-pct { font-size: 1.7rem; font-weight: 800; font-variant-numeric: tabular-nums; line-height: 1.1; }
.duel-bar { height: .5rem; border-radius: 999px; background: var(--surface-2); border: 1px solid var(--border); overflow: hidden; }
.duel-bar > span { display: block; height: 100%; border-radius: 999px; background: linear-gradient(90deg, var(--accent), var(--accent-deep)); opacity: .85; transition: width .5s ease; }
.duel-card.mine .duel-bar > span { opacity: 1; }
.poll-count { color: var(--muted); font-size: .82rem; font-variant-numeric: tabular-nums; white-space: nowrap; }
.duel-card.mine .poll-count { color: inherit; font-weight: 700; }
.duel-pick {
  position: absolute; top: -.65rem; right: -.65rem; width: 1.9rem; height: 1.9rem; border-radius: 50%;
  background: var(--accent); color: #fff; font-size: .95rem; font-weight: 800;
  display: flex; align-items: center; justify-content: center; box-shadow: 0 2px 8px rgba(0,0,0,.2);
}
.duel-vs { align-self: center; font-family: var(--serif); font-style: italic; font-size: 1.1rem; color: var(--faint); padding: 0 .25rem; }
.duel-alt { display: flex; gap: .5rem; flex-wrap: wrap; margin: 0 0 1rem; }
.duel-alt-btn {
  appearance: none; cursor: pointer; font: 600 .82rem var(--sans, system-ui, sans-serif); color: var(--text);
  background: var(--surface); border: 1px solid var(--border); border-radius: 999px; padding: .45rem .9rem;
  display: inline-flex; align-items: center; gap: .55rem; transition: border-color .15s, transform .1s;
}
.duel-alt-btn:hover { border-color: var(--accent); }
.duel-alt-btn:active { transform: scale(.97); }
.duel-alt-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.duel-alt-btn.mine { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; color: var(--accent-deep); font-weight: 700; }
.duel-alt-btn[disabled] { opacity: .55; cursor: wait; }
.poll-total { margin-top: .9rem; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
@media (max-width: 640px) {
  .duel { grid-template-columns: 1fr; }
  .duel-vs { justify-self: center; }
}
`;

const POLL_SCRIPT = `
(function () {
  document.querySelectorAll('[data-poll-widget]').forEach(function (root) {
    var adaptationId = root.getAttribute('data-poll-widget');
    var ORDER = ['book', 'screen', 'both', 'undecided'];
    var LABELS = { book: 'Book', screen: 'Screen', both: 'Both great', undecided: 'Undecided' };
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
        var bar = row.querySelector('.duel-bar > span');
        if (bar) bar.style.width = percent + '%';
        var pctEl = row.querySelector('.duel-pct');
        if (pctEl) pctEl.textContent = percent + '%';
        var count = row.querySelector('.poll-count');
        if (count) count.textContent = n + ' · ' + percent + '%';
        var isMine = mine === choice;
        row.classList.toggle('mine', isMine);
        if (row.hasAttribute('data-poll-btn')) {
          row.setAttribute('aria-pressed', String(isMine));
          var pick = row.querySelector('.duel-pick');
          if (pick) pick.hidden = !isMine;
          if (row.classList.contains('duel-alt-btn')) {
            var lab = row.querySelector('span');
            if (lab) lab.textContent = isMine ? LABELS[choice] + ' ✓' : LABELS[choice];
          }
        }
      });
      var totalEl = root.querySelector('[data-poll-total]');
      if (totalEl) totalEl.textContent = total === 1 ? '1 vote' : total + ' votes';
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

function duelArt(url: string | null, title: string) {
  return url ? (
    <span class="duel-art">
      <img src={url} alt="" loading="lazy" />
    </span>
  ) : (
    <span class="duel-art" aria-hidden="true">
      {title.charAt(0)}
    </span>
  );
}

function DuelCard({
  choice,
  side,
  title,
  artUrl,
  count,
  total,
  isMine,
}: {
  choice: 'book' | 'screen';
  side: string;
  title: string;
  artUrl: string | null;
  count: number;
  total: number;
  isMine: boolean;
}) {
  return (
    <button
      type="button"
      class={`duel-card${isMine ? ' mine' : ''}`}
      data-poll-btn={choice}
      data-poll-row={choice}
      aria-pressed={isMine ? 'true' : 'false'}
      aria-label={`${CHOICE_LABELS[choice]}: ${title}`}
    >
      <span class="duel-pick" aria-hidden="true" hidden={!isMine}>
        ✓
      </span>
      {duelArt(artUrl, title)}
      <span class="duel-body">
        <span class="duel-side">{side}</span>
        <span class="duel-name">{title}</span>
        <span class="duel-pct" aria-hidden="true">
          {pct(count, total)}%
        </span>
        <span class="duel-bar" aria-hidden="true">
          <span style={`width:${pct(count, total)}%`}></span>
        </span>
        <span class="poll-count">
          {count} · {pct(count, total)}%
        </span>
      </span>
    </button>
  );
}

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
  art,
}: PollWidgetProps) {
  return (
    <div
      class="poll-widget"
      data-poll-widget={String(adaptationId)}
      data-poll-signed-in={signedIn ? '1' : '0'}
    >
      <style dangerouslySetInnerHTML={{ __html: POLL_CSS }} />
      <h2 class="section-title">Which was better?</h2>
      <div class="duel" role="group" aria-label="Which was better?">
        <DuelCard
          choice="book"
          side="📖 The book"
          title={art.bookTitle}
          artUrl={art.bookCoverUrl}
          count={counts.book}
          total={total}
          isMine={userChoice === 'book'}
        />
        <span class="duel-vs" aria-hidden="true">
          vs
        </span>
        <DuelCard
          choice="screen"
          side="🎬 The screen"
          title={art.screenTitle}
          artUrl={art.screenPosterUrl}
          count={counts.screen}
          total={total}
          isMine={userChoice === 'screen'}
        />
      </div>
      <div class="duel-alt" role="group" aria-label="Something else?">
        {(['both', 'undecided'] as PollChoice[]).map((choice) => (
          <button
            type="button"
            class={`duel-alt-btn${userChoice === choice ? ' mine' : ''}`}
            data-poll-btn={choice}
            data-poll-row={choice}
            aria-pressed={userChoice === choice ? 'true' : 'false'}
          >
            <span>
              {CHOICE_LABELS[choice]}
              {userChoice === choice ? ' ✓' : ''}
            </span>
            <span class="poll-count">
              {counts[choice]} · {pct(counts[choice], total)}%
            </span>
          </button>
        ))}
      </div>
      <div aria-live="polite" class="sr-only">
        {CHOICE_ORDER.map((choice) => (
          <span key={choice}>
            {CHOICE_LABELS[choice]}: {counts[choice]} votes
          </span>
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
