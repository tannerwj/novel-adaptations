// src/feedback/pages.tsx — Track D: public feedback form, thanks page, and
// the admin triage queue (plain Hono JSX functions; Layout from ../ui).
//
// The admin list shows only what each reporter submitted (feedback.email as
// entered, or a "signed in" badge from feedback.user_id). It never joins
// against users, so other users' account emails can never leak here.

import { Layout, type ThemeName } from '../ui';
import type { FeedbackRow, FeedbackStatus, FeedbackType } from './db';
import { FEEDBACK_STATUSES, FEEDBACK_TYPES } from './db';

export interface AuthUserView {
  email: string;
  isAdmin: boolean;
}

export interface FeedbackFormValues {
  type: string;
  subject: string;
  body: string;
  proofUrl: string;
  email: string;
}

const TYPE_LABELS: Record<FeedbackType, string> = {
  feature: 'Feature idea',
  adaptation_tip: 'Adaptation tip — this book has an adaptation',
  correction: 'Correction',
  other: 'Other',
};

const STATUS_LABELS: Record<FeedbackStatus, string> = {
  new: 'New',
  reviewed: 'Reviewed',
  done: 'Done',
};

export function FeedbackPage({
  user,
  prefillType,
  prefillSubject,
  error,
  values,
  theme,
}: {
  user?: AuthUserView | null;
  prefillType?: FeedbackType;
  prefillSubject?: string;
  error?: string;
  values?: FeedbackFormValues;
  theme?: ThemeName;
}) {
  const type = values?.type ?? prefillType ?? 'feature';
  const subject = values?.subject ?? prefillSubject ?? '';
  const body = values?.body ?? '';
  const proofUrl = values?.proofUrl ?? '';
  const email = values?.email ?? '';
  return (
    <Layout title="Send feedback" user={user ?? undefined} theme={theme}>
      <div class="feedback-card">
        <p class="kicker">We read everything</p>
        <h1>Send feedback</h1>
        <p>
          Suggest a feature, report an adaptation we're missing, or flag a
          correction. No account needed.
        </p>
        {error && <div class="auth-error">{error}</div>}
        <form action="/api/feedback" method="post">
          <label for="fb-type">
            What kind of feedback?
            <select id="fb-type" name="type" required>
              {FEEDBACK_TYPES.map((t) => (
                <option value={t} selected={t === type} key={t}>
                  {TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </label>
          <label for="fb-subject">
            Subject <span class="hint">(3–120 characters)</span>
            <input
              type="text"
              id="fb-subject"
              name="subject"
              required
              minlength={3}
              maxlength={120}
              value={subject}
              placeholder="e.g. Wrong release date for Dune: Part Three"
            />
          </label>
          <label for="fb-body">
            Details <span class="hint">(10–5000 characters)</span>
            <textarea
              id="fb-body"
              name="body"
              required
              minlength={10}
              maxlength={5000}
              placeholder="Tell us what's wrong or what you'd like to see…"
            >
              {body}
            </textarea>
          </label>
          <label for="fb-proof">
            Proof URL <span class="hint">(optional — a source that backs you up)</span>
            <input
              type="url"
              id="fb-proof"
              name="proof_url"
              value={proofUrl}
              placeholder="https://…"
            />
          </label>
          {!user?.email && (
            <label for="fb-email">
              Email <span class="hint">(optional — only if you want a reply)</span>
              <input
                type="email"
                id="fb-email"
                name="email"
                value={email}
                autocomplete="email"
                placeholder="you@example.com"
              />
            </label>
          )}
          <button class="btn btn-primary" type="submit">
            Send feedback
          </button>
        </form>
      </div>
    </Layout>
  );
}

export function FeedbackThanksPage({ user, theme }: { user?: AuthUserView | null; theme?: ThemeName }) {
  return (
    <Layout title="Thanks!" user={user ?? undefined} theme={theme}>
      <div class="feedback-card">
        <p class="kicker">Received</p>
        <h1>Thanks for the feedback! 🎬</h1>
        <p>
          Your note is in the queue and a human will look at it. Want to keep
          browsing?
        </p>
        <p>
          <a href="/">← Back to all adaptations</a>
        </p>
      </div>
    </Layout>
  );
}

export function AdminFeedbackPage({
  items,
  type,
  status,
  counts,
  theme,
}: {
  items: FeedbackRow[];
  type?: FeedbackType;
  status?: FeedbackStatus;
  counts: Record<FeedbackStatus, number>;
  theme?: ThemeName;
}) {
  const typeQuery = type ? `&type=${type}` : '';
  return (
    <Layout title="Feedback triage" theme={theme}>
      <p class="kicker">Owner console</p>
      <h1 class="display-title">Feedback</h1>
      <p class="lede">
        What readers are telling us. Triage with the buttons; emails shown are
        only what the reporter typed into the form.
      </p>
      <nav class="tabs" aria-label="Feedback status">
        <a href={`/admin/feedback${typeQuery}`} class={!status ? 'active' : ''}>
          all
        </a>
        {FEEDBACK_STATUSES.map((s) => (
          <a
            href={`/admin/feedback?status=${s}${typeQuery}`}
            class={s === status ? 'active' : ''}
            key={s}
          >
            {STATUS_LABELS[s]} ({counts[s] ?? 0})
          </a>
        ))}
      </nav>
      <form method="get" action="/admin/feedback" class="actions" style="margin-bottom:1.5rem">
        {status && <input type="hidden" name="status" value={status} />}
        <label for="fb-filter-type" class="meta">Type:</label>
        <select id="fb-filter-type" name="type" onchange="this.form.submit()">
          <option value="">all types</option>
          {FEEDBACK_TYPES.map((t) => (
            <option value={t} selected={t === type} key={t}>
              {TYPE_LABELS[t]}
            </option>
          ))}
        </select>
        {type && (
          <a class="btn btn-sm" href={`/admin/feedback${status ? `?status=${status}` : ''}`}>
            clear type
          </a>
        )}
      </form>

      {items.length === 0 ? (
        <p class="empty">Nothing here. The inbox is clear. 🎬</p>
      ) : (
        items.map((item) => (
          <article class="queue-item" key={item.id}>
            <h3>{item.subject}</h3>
            <div class="badges">
              <span class="kind-pill">{TYPE_LABELS[item.type]}</span>
              <span class="kind-pill">{STATUS_LABELS[item.status]}</span>
              {item.user_id !== null && <span class="meta">signed in</span>}
            </div>
            <p class="summary">{item.body}</p>
            <p class="meta">
              #{item.id} · {item.created_at}
              {item.email ? ` · ${item.email}` : ''}
              {item.proof_url && (
                <>
                  {' · '}
                  <a href={item.proof_url} target="_blank" rel="noopener noreferrer">
                    proof ↗
                  </a>
                </>
              )}
            </p>
            {item.status !== 'done' && (
              <div class="actions">
                {item.status === 'new' && (
                  <button
                    type="button"
                    class="btn btn-sm"
                    data-act="reviewed"
                    data-path={`/api/feedback/${item.id}/status`}
                  >
                    Mark reviewed
                  </button>
                )}
                {item.type === 'adaptation_tip' && (
                  <button
                    type="button"
                    class="btn btn-sm btn-primary"
                    data-act="intake"
                    data-path={`/api/feedback/${item.id}/intake`}
                  >
                    Fetch metadata
                  </button>
                )}
                <button
                  type="button"
                  class="btn btn-sm btn-primary"
                  data-act="done"
                  data-path={`/api/feedback/${item.id}/status`}
                >
                  Mark done
                </button>
              </div>
            )}
          </article>
        ))
      )}

      <script dangerouslySetInnerHTML={{ __html: FEEDBACK_ADMIN_SCRIPT }} />
    </Layout>
  );
}

/** Triage actions: status posts reload the queue; intake renders its result
 *  inline (no alert(), no reload). */
const FEEDBACK_ADMIN_SCRIPT = `
document.querySelectorAll('button[data-act]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const card = btn.closest('.queue-item');
    const act = btn.getAttribute('data-act');
    const showError = (msg) => {
      let el = card.querySelector('[data-inline-error]');
      if (!el) {
        el = document.createElement('p');
        el.className = 'form-error';
        el.setAttribute('data-inline-error', '1');
        btn.closest('.actions').after(el);
      }
      el.textContent = msg;
      el.classList.add('visible');
    };
    if (act === 'intake') {
      btn.disabled = true;
      const original = btn.textContent;
      btn.textContent = 'Fetching…';
      try {
        const res = await fetch(btn.getAttribute('data-path'), { method: 'POST' });
        let data = {};
        try { data = await res.json(); } catch (e) {}
        if (!res.ok) { showError('Error: ' + (data.error || res.status)); return; }
        const lines = [
          (data.book.created ? 'Created book: ' : 'Reused book: ') + data.book.title,
          (data.screenWork.created ? 'Created ' + data.screenWork.kind + ': ' : 'Reused ' + data.screenWork.kind + ': ') + data.screenWork.title,
          'Adaptation ' + (data.adaptation.created ? 'created' : 'already existed') + ' (' + data.adaptation.status + ')',
        ].concat(data.warnings || []);
        const panel = document.createElement('div');
        panel.className = 'intake-result';
        const ul = document.createElement('ul');
        lines.forEach((line) => {
          const li = document.createElement('li');
          li.textContent = line;
          ul.appendChild(li);
        });
        panel.appendChild(ul);
        btn.closest('.actions').replaceWith(panel);
        // The server marked the tip done — reflect it in place.
        // Markup order in this file: type pill first, status pill second.
        const pills = card.querySelectorAll('.badges .kind-pill');
        if (pills[1]) pills[1].textContent = 'Done';
        card.style.opacity = '0.7';
      } finally {
        if (btn.isConnected) { btn.disabled = false; btn.textContent = original; }
      }
      return;
    }
    const res = await fetch(btn.getAttribute('data-path'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: act }),
    });
    let data = {};
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) { showError('Error: ' + (data.error || res.status)); return; }
    location.reload();
  });
});
`;
