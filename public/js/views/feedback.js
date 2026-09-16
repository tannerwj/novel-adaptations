// public/js/views/feedback.js — public feedback form + thanks state.

import { esc } from '../utils.js';
import { api, errMsg } from '../api.js';
import { store } from '../store.js';

const TYPE_LABELS = {
  feature: 'Feature idea',
  adaptation_tip: 'Adaptation tip — this book has an adaptation',
  correction: 'Correction',
  other: 'Other',
};
const FEEDBACK_TYPES = Object.keys(TYPE_LABELS);

function formHtml({ prefillType, prefillSubject, values, error }) {
  const type = values?.type ?? prefillType ?? 'feature';
  const subject = values?.subject ?? prefillSubject ?? '';
  const body = values?.body ?? '';
  const proofUrl = values?.proof_url ?? '';
  const email = values?.email ?? '';
  return (
    `<div class="feedback-card">` +
      `<p class="kicker">We read everything</p>` +
      `<h1>Send feedback</h1>` +
      `<p>Suggest a feature, report an adaptation we're missing, or flag a correction. No account needed.</p>` +
      (error ? `<div class="auth-error">${esc(error)}</div>` : '') +
      `<form data-feedback-form>` +
        `<label for="fb-type">What kind of feedback?` +
          `<select id="fb-type" name="type" required>` +
          FEEDBACK_TYPES.map((t) => `<option value="${t}"${t === type ? ' selected' : ''}>${esc(TYPE_LABELS[t])}</option>`).join('') +
          `</select></label>` +
        `<label for="fb-subject">Subject <span class="hint">(3–120 characters)</span>` +
          `<input type="text" id="fb-subject" name="subject" required minlength="3" maxlength="120" value="${esc(subject)}" placeholder="e.g. Wrong release date for Dune: Part Three"></label>` +
        `<label for="fb-body">Details <span class="hint">(10–5000 characters)</span>` +
          `<textarea id="fb-body" name="body" required minlength="10" maxlength="5000" placeholder="Tell us what's wrong or what you'd like to see…">${esc(body)}</textarea></label>` +
        `<label for="fb-proof">Proof URL <span class="hint">(optional — a source that backs you up)</span>` +
          `<input type="url" id="fb-proof" name="proof_url" value="${esc(proofUrl)}" placeholder="https://…"></label>` +
        (!store.user
          ? `<label for="fb-email">Email <span class="hint">(optional — only if you want a reply)</span>` +
            `<input type="email" id="fb-email" name="email" value="${esc(email)}" autocomplete="email" placeholder="you@example.com"></label>`
          : '') +
        `<button class="btn btn-primary" type="submit">Send feedback</button>` +
      `</form>` +
    `</div>`
  );
}

function thanksHtml() {
  return (
    `<div class="feedback-card">` +
      `<p class="kicker">Received</p>` +
      `<h1>Thanks for the feedback! 🎬</h1>` +
      `<p>Your note is in the queue and a human will look at it. Want to keep browsing?</p>` +
      `<p><a href="/">← Back to all adaptations</a></p>` +
    `</div>`
  );
}

function wireForm(root, prefill) {
  const form = root.querySelector('[data-feedback-form]');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const values = {
      type: String(fd.get('type') || ''),
      subject: String(fd.get('subject') || '').trim(),
      body: String(fd.get('body') || '').trim(),
      proof_url: String(fd.get('proof_url') || '').trim() || null,
      email: String(fd.get('email') || '').trim() || null,
    };
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    const r = await api('/api/v1/feedback', { method: 'POST', body: values, loginRedirect: false });
    if (!r.ok) {
      // Re-render the form in place with values preserved and the envelope message inline.
      root.innerHTML = formHtml({
        ...prefill,
        values: { ...values, proof_url: values.proof_url ?? '', email: values.email ?? '' },
        error: r.code === 'rate_limited' ? 'Too many submissions — try again in an hour.' : errMsg(r),
      });
      wireForm(root, prefill);
      return;
    }
    // Success → thanks state, no reload.
    window.history.replaceState(null, '', '/feedback?sent=1');
    document.title = 'Thanks! — Novel Adaptations';
    root.innerHTML = thanksHtml();
  });
}

export async function feedbackView({ query }) {
  const rawType = query.type;
  const prefill = {
    prefillType: FEEDBACK_TYPES.includes(rawType) ? rawType : undefined,
    prefillSubject: query.subject ?? '',
  };
  const showThanks = query.sent === '1';
  return {
    title: 'Send feedback',
    html: showThanks ? thanksHtml() : formHtml(prefill),
    after(root) { if (!showThanks) wireForm(root, prefill); },
  };
}

