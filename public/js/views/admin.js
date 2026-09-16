// public/js/views/admin.js — admin pages: news queue, pipeline runs, screen works, feedback triage.
// All shapes follow docs/API.md via src/api/v1.ts.

import { esc, safeUrl } from '../utils.js';
import { watchUrl } from '../links.js';
import { api, errMsg } from '../api.js';
import { pagination, wirePagination } from '../components.js';

function adminBar(active) {
  const links = [
    ['/admin/news', '📰 News queue'],
    ['/admin/news/runs', '⏱ Pipeline runs'],
    ['/admin/screen-works', '🎬 Screen works'],
    ['/admin/feedback', '💬 Feedback'],
  ];
  return (
    `<nav class="admin-bar" aria-label="Admin">` +
      links.map(([href, label]) =>
        `<a href="${href}"${active === href ? ' class="active"' : ''}>${label}</a>`
      ).join('') +
    `</nav>`
  );
}

function backfillHtml(loading, message) {
  return (
    `<section class="panel" style="margin-top:2rem">` +
      `<h2>Poster backfill</h2>` +
      `<p class="meta">Fetches missing posters, backdrops, and release dates from TMDB (10 screen works per run — the API batch cap). Results appear below after each run.</p>` +
      (message ? `<div class="${message.ok ? 'auth-success' : 'auth-error'}" role="status">${esc(message.text)}</div>` : '') +
      `<form data-backfill style="display:flex;gap:.75rem;align-items:center;margin-top:.75rem">` +
        `<button class="btn btn-primary" type="submit"${loading ? ' disabled' : ''}>${loading ? 'Running…' : 'Run backfill (10 works)'}</button>` +
      `</form>` +
    `</section>`
  );
}

function wireBackfill(mount) {
  const form = mount.querySelector('[data-backfill]');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    mount.innerHTML = backfillHtml(true, null);
    wireBackfill(mount);
    const r = await api('/api/v1/admin/backfill/tmdb?n=10', { method: 'POST' });
    mount.innerHTML = backfillHtml(false, r.ok
      ? { ok: true, text: `Backfill complete: ${r.data.enriched} enriched, ${r.data.failed} failed, ${r.data.done} processed — ${r.data.remaining} still missing posters/dates.` }
      : { ok: false, text: errMsg(r) });
    wireBackfill(mount);
  });
}

// ---------------------------------------------------------------------------
// /admin/news — pending queue + approve/dismiss/promote
// ---------------------------------------------------------------------------

const NEWS_STATUSES = ['pending', 'approved', 'dismissed'];
const NEWS_STATUS_LABELS = { pending: 'Pending', approved: 'Approved', dismissed: 'Dismissed' };

function newsCardHtml(it) {
  const link = safeUrl(it.url);
  return (
    `<article class="news-review-card" data-news-id="${it.id}">` +
      `<p class="meta">#${it.id} · ${esc(it.source)} · trust: ${esc(it.trust_tier)}${it.published_at ? ` · published ${esc(it.published_at.slice(0, 10))}` : ''}</p>` +
      `<h2 class="news-title">${link ? `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer">${esc(it.title)}</a>` : esc(it.title)}</h2>` +
      (it.summary ? `<p>${esc(it.summary)}</p>` : '') +
      ((it.book_title || it.author || it.status_signal)
        ? `<p class="meta">→ ${esc(it.book_title ?? 'unknown book')}${it.author ? ` by ${esc(it.author)}` : ''}${it.screen_kind ? ` · ${esc(it.screen_kind)}` : ''}${it.status_signal ? ` · signal: ${esc(it.status_signal)}` : ''}${it.confidence != null ? ` · confidence ${it.confidence}` : ''}</p>`
        : '') +
      `<div class="actions">` +
        `<button class="btn btn-primary btn-sm" type="button" data-news-action="approve">✓ Approve</button>` +
        `<button class="btn btn-sm" type="button" data-news-action="promote">⬆ Promote</button>` +
        `<button class="btn btn-sm" type="button" data-news-action="dismiss">✕ Dismiss</button>` +
      `</div>` +
    `</article>`
  );
}

export async function adminNewsView({ query }) {
  const status = NEWS_STATUSES.includes(query.status) ? query.status : 'pending';
  const renderPage = async (page = 1) => {
    const r = await api(`/api/v1/admin/news?status=${status}&page=${page}&per_page=25`);
    if (!r.ok) throw new Error(errMsg(r));
    const { items, counts } = r.data;
    const { data, page: pg, per_page, total } = items;
    return {
      title: 'Admin · News queue',
      html:
        adminBar('/admin/news') +
        `<p class="kicker">Admin</p>` +
        `<h1 class="display-title">News queue</h1>` +
        `<p class="lede">AI-drafted stories awaiting review. Approving publishes a story to the site; promoting pushes it to the top; dismissing removes it.</p>` +
        `<div class="actions" style="margin-bottom:1.5rem">` +
          NEWS_STATUSES.map((s) =>
            `<a href="/admin/news?status=${s}" class="btn btn-sm${s === status ? ' btn-primary' : ''}">${NEWS_STATUS_LABELS[s]}${counts && counts[s] != null ? ` (${counts[s]})` : ''}</a>`
          ).join('') +
        `</div>` +
        (data.length === 0
          ? `<p class="empty">Nothing ${status === 'pending' ? 'awaiting review' : `with status “${NEWS_STATUS_LABELS[status].toLowerCase()}”`}.</p>`
          : `<div data-queue>${data.map(newsCardHtml).join('')}</div>`) +
        pagination(pg, per_page, total),
      after(root) {
        root.querySelectorAll('[data-news-id]').forEach((card) => {
          if (card.dataset.wired) return;
          card.dataset.wired = '1';
          const id = card.dataset.newsId;
          card.querySelectorAll('[data-news-action]').forEach((btn) => {
            btn.addEventListener('click', async () => {
              const action = btn.dataset.newsAction;
              if (action === 'dismiss' && !confirm('Dismiss this story? It will be removed from the queue.')) return;
              btn.disabled = true;
              const r2 = await api(`/api/v1/admin/news/${id}/${action}`, { method: 'POST' });
              if (!r2.ok) { btn.disabled = false; alert(errMsg(r2)); return; }
              card.style.opacity = '0.4';
              card.querySelector('.actions').innerHTML =
                `<span class="meta">✓ ${action === 'approve' ? 'Approved — published.' : action === 'promote' ? 'Promoted.' : 'Dismissed.'}</span>`;
            });
          });
        });
        wirePagination(root, (p) => refresh(p));
      },
    };
  };
  const out = await renderPage(1);
  const refresh = async (page) => {
    const next = await renderPage(page);
    document.title = `${next.title} — Novel Adaptations`;
    document.getElementById('app').innerHTML = next.html;
    next.after(document.getElementById('app'));
  };
  return out;
}

// ---------------------------------------------------------------------------
// /admin/news/runs — pipeline runs + backfill
// ---------------------------------------------------------------------------

/** Real fields from the pipeline_runs row (src/news/ingest.ts): id, status,
 *  feeds_ok, feeds_failed, items_fetched, items_new, items_skipped_cap,
 *  llm_calls, started_at, errors (string|null). */
function runRowHtml(r) {
  return (
    `<tr>` +
      `<td>#${r.id}</td>` +
      `<td>${esc(r.status)}</td>` +
      `<td>${r.feeds_ok ?? '—'}${r.feeds_failed != null && r.feeds_failed !== 0 ? ` / ${r.feeds_failed} failed` : ''}</td>` +
      `<td>${r.items_fetched ?? '—'}</td>` +
      `<td>${r.items_new ?? '—'}</td>` +
      `<td>${r.items_skipped_cap ?? '—'}</td>` +
      `<td>${r.llm_calls ?? '—'}</td>` +
      `<td>${r.started_at ? esc(r.started_at) : '—'}</td>` +
      `<td>${r.errors ? esc(r.errors) : '—'}</td>` +
    `</tr>`
  );
}

/** Mobile labeled-card version of the same data — no horizontal scrolling. */
function runCardHtml(r) {
  const field = (label, value) =>
    `<div><dt>${label}</dt><dd>${value}</dd></div>`;
  return (
    `<article class="run-card">` +
      `<div class="run-card-head">` +
        `<span class="run-id">Run #${r.id}</span>` +
        `<span class="status-pill ${esc(r.status)}">${esc(r.status)}</span>` +
      `</div>` +
      `<dl>` +
        field('Feeds ok/failed', `${r.feeds_ok ?? '—'}${r.feeds_failed != null ? ` / ${r.feeds_failed}` : ''}`) +
        field('Fetched', `${r.items_fetched ?? '—'}`) +
        field('New', `${r.items_new ?? '—'}`) +
        field('Skipped', `${r.items_skipped_cap ?? '—'}`) +
        field('LLM calls', `${r.llm_calls ?? '—'}`) +
        field('Started', `${r.started_at ? esc(r.started_at) : '—'}`) +
        (r.errors
          ? `<div class="run-card-error"><dt>Error</dt><dd>${esc(r.errors)}</dd></div>`
          : '') +
      `</dl>` +
    `</article>`
  );
}

const RUNS_HEAD = `<thead><tr><th>Run</th><th>Status</th><th>Feeds ok/failed</th><th>Fetched</th><th>New</th><th>Skipped</th><th>LLM calls</th><th>Started</th><th>Error</th></tr></thead>`;

function runsTableHtml(data) {
  return (
    `<div data-runs-table>` +
      `<div class="table-wrap"><table class="admin-table">${RUNS_HEAD}` +
        `<tbody>${data.map(runRowHtml).join('')}</tbody>` +
      `</table></div>` +
      `<div class="run-cards">${data.map(runCardHtml).join('')}</div>` +
    `</div>`
  );
}

export async function adminRunsView() {
  const runsR = await api('/api/v1/admin/news/runs?per_page=25');
  if (!runsR.ok) throw new Error(errMsg(runsR));
  const { data, page: pg, per_page, total } = runsR.data.runs;
  return {
    title: 'Admin · Pipeline runs',
    html:
      adminBar('/admin/news/runs') +
      `<p class="kicker">Admin</p>` +
      `<h1 class="display-title">Pipeline runs</h1>` +
      `<p class="lede">Daily news ingestion history — fetched / new / skipped per run, newest first.</p>` +
      (data.length === 0
        ? `<p class="empty">No pipeline runs yet.</p>`
        : runsTableHtml(data)) +
      pagination(pg, per_page, total) +
      `<div data-backfill-slot></div>`,
    after(root) {
      const mount = root.querySelector('[data-backfill-slot]');
      mount.innerHTML = backfillHtml(false, null);
      wireBackfill(mount);
      const refreshRuns = async (page) => {
        const rr = await api(`/api/v1/admin/news/runs?page=${page}&per_page=25`);
        if (!rr.ok) { alert(errMsg(rr)); return; }
        const box = root.querySelector('[data-runs-table]');
        if (box) box.outerHTML = runsTableHtml(rr.data.runs.data);
        const old = root.querySelector('[data-pagination]');
        if (old) {
          const tmp = document.createElement('div');
          tmp.innerHTML = pagination(rr.data.runs.page, rr.data.runs.per_page, rr.data.runs.total);
          old.replaceWith(tmp.firstChild);
        }
        wirePagination(root, refreshRuns);
      };
      wirePagination(root, refreshRuns);
    },
  };
}

// ---------------------------------------------------------------------------
// /admin/screen-works — release-date editing
// ---------------------------------------------------------------------------

function workCardHtml(w) {
  return (
    `<div class="list-card" data-work-id="${w.id}">` +
      `<div class="grow">` +
        `<h2 class="work-title"><a href="${watchUrl(w)}">${esc(w.title)}</a></h2>` +
        `<p class="meta">#${w.id} · ${esc(w.kind)}${w.tmdb_id ? ` · TMDB ${w.tmdb_id}` : ' · no TMDB id'}</p>` +
        `<form data-release-date style="display:flex;gap:.5rem;align-items:center;margin-top:.5rem;flex-wrap:wrap">` +
          `<label class="meta" for="rd-${w.id}">Release date</label>` +
          `<input class="f-input" type="date" id="rd-${w.id}" name="release_date" value="${esc(w.release_date ?? '')}" style="max-width:11rem">` +
          `<button class="btn btn-sm" type="submit">Save</button>` +
          `<button class="btn btn-sm btn-ghost" type="button" data-clear-date>Clear</button>` +
          `<span class="meta" data-date-msg role="status"></span>` +
        `</form>` +
      `</div>` +
    `</div>`
  );
}

export async function adminScreenWorksView() {
  const renderPage = async (page = 1) => {
    const r = await api(`/api/v1/admin/screen-works?page=${page}&per_page=25`);
    if (!r.ok) throw new Error(errMsg(r));
    const { data, page: pg, per_page, total } = r.data.screen_works;
    return {
      title: 'Admin · Screen works',
      html:
        adminBar('/admin/screen-works') +
        `<p class="kicker">Admin</p>` +
        `<h1 class="display-title">Screen works</h1>` +
        `<p class="lede">Works with no release date first. Set a date (or clear it back to TBA) — changes apply instantly, no reload.</p>` +
        (data.length === 0
          ? `<p class="empty">No screen works found.</p>`
          : `<div data-works>${data.map(workCardHtml).join('')}</div>`) +
        pagination(pg, per_page, total),
      after(root) {
        root.querySelectorAll('[data-work-id]').forEach((card) => {
          if (card.dataset.wired) return;
          card.dataset.wired = '1';
          const form = card.querySelector('[data-release-date]');
          const input = form.querySelector('input[name="release_date"]');
          const msg = form.querySelector('[data-date-msg]');
          const save = async (value) => {
            msg.textContent = 'Saving…';
            const r2 = await api(`/api/v1/admin/screen-works/${card.dataset.workId}/release-date`, {
              method: 'POST',
              body: { release_date: value },
            });
            if (!r2.ok) { msg.textContent = errMsg(r2); return; }
            msg.textContent = r2.data.release_date ? `✓ Saved (${esc(r2.data.release_date)})` : '✓ Cleared to TBA';
            input.value = r2.data.release_date ?? '';
          };
          form.addEventListener('submit', (e) => { e.preventDefault(); save(input.value); });
          form.querySelector('[data-clear-date]').addEventListener('click', () => save(''));
        });
        wirePagination(root, (p) => refresh(p));
      },
    };
  };
  const out = await renderPage(1);
  const refresh = async (page) => {
    const next = await renderPage(page);
    document.title = `${next.title} — Novel Adaptations`;
    document.getElementById('app').innerHTML = next.html;
    next.after(document.getElementById('app'));
  };
  return out;
}

// ---------------------------------------------------------------------------
// /admin/feedback — triage queue (statuses: new → reviewed → done)
// ---------------------------------------------------------------------------

const FB_STATUSES = ['new', 'reviewed', 'done'];
const FB_STATUS_LABELS = { new: 'New', reviewed: 'Reviewed', done: 'Done' };
const FB_TYPE_LABELS = {
  feature: 'Feature idea',
  adaptation_tip: 'Adaptation tip',
  correction: 'Correction',
  other: 'Other',
};

function feedbackRowHtml(fb) {
  const link = safeUrl(fb.proof_url);
  return (
    `<div class="feedback-row" data-feedback-id="${fb.id}">` +
      `<div class="grow">` +
        `<div class="meta">#${fb.id} · ${esc(FB_TYPE_LABELS[fb.type] ?? fb.type)} · ${esc(FB_STATUS_LABELS[fb.status] ?? fb.status)} · ${esc(fb.created_at.slice(0, 10))}${fb.email ? ` · ${esc(fb.email)}` : ''}</div>` +
        `<h2 class="feedback-subject">${esc(fb.subject)}</h2>` +
        `<p>${esc(fb.body.length > 300 ? fb.body.slice(0, 300) + '…' : fb.body)}</p>` +
        (link ? `<p class="meta">Proof: <a href="${esc(link)}" target="_blank" rel="noopener noreferrer">${esc(fb.proof_url)}</a></p>` : '') +
      `</div>` +
      `<div class="row-actions">` +
        (fb.status !== 'reviewed' ? `<button class="btn btn-sm" type="button" data-fb-status="reviewed">Mark reviewed</button>` : '') +
        (fb.status !== 'done' ? `<button class="btn btn-sm" type="button" data-fb-status="done">Mark done</button>` : '') +
      `</div>` +
    `</div>`
  );
}

export async function adminFeedbackView({ query }) {
  const status = FB_STATUSES.includes(query.status) ? query.status : undefined;
  const renderPage = async (page = 1) => {
    const qs = new URLSearchParams({ page, per_page: 25 });
    if (status) qs.set('status', status);
    const r = await api(`/api/v1/admin/feedback?${qs}`);
    if (!r.ok) throw new Error(errMsg(r));
    const { feedback, counts } = r.data;
    const { data, page: pg, per_page, total } = feedback;
    return {
      title: 'Admin · Feedback',
      html:
        adminBar('/admin/feedback') +
        `<p class="kicker">Admin</p>` +
        `<h1 class="display-title">Feedback triage</h1>` +
        `<p class="lede">User-submitted feedback, corrections, and adaptation tips.</p>` +
        `<div class="actions" style="margin-bottom:1.5rem">` +
          ['', ...FB_STATUSES].map((s) => {
            const label = s === '' ? 'All' : `${FB_STATUS_LABELS[s]}${counts && counts[s] != null ? ` (${counts[s]})` : ''}`;
            const active = (status ?? '') === s;
            const href = s ? `/admin/feedback?status=${s}` : '/admin/feedback';
            return `<a href="${href}" class="btn btn-sm${active ? ' btn-primary' : ''}">${label}</a>`;
          }).join('') +
        `</div>` +
        (data.length === 0
          ? `<p class="empty">Nothing here${status ? ` with status “${FB_STATUS_LABELS[status]}”` : ''}.</p>`
          : `<div data-feedback-list>${data.map(feedbackRowHtml).join('')}</div>`) +
        pagination(pg, per_page, total),
      after(root) {
        root.querySelectorAll('[data-feedback-id]').forEach((row) => {
          if (row.dataset.wired) return;
          row.dataset.wired = '1';
          row.querySelectorAll('[data-fb-status]').forEach((btn) => {
            btn.addEventListener('click', async () => {
              btn.disabled = true;
              const r2 = await api(`/api/v1/admin/feedback/${row.dataset.feedbackId}/status`, {
                method: 'POST',
                body: { status: btn.dataset.fbStatus },
              });
              if (!r2.ok) { btn.disabled = false; alert(errMsg(r2)); return; }
              row.style.opacity = '0.4';
              btn.remove();
            });
          });
        });
        wirePagination(root, (p) => refresh(p));
      },
    };
  };
  const out = await renderPage(1);
  const refresh = async (page) => {
    const next = await renderPage(page);
    document.title = `${next.title} — Novel Adaptations`;
    document.getElementById('app').innerHTML = next.html;
    next.after(document.getElementById('app'));
  };
  return out;
}
