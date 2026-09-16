// public/js/views/auth.js — login request, verify-token, success/error states.

import { esc } from '../utils.js';
import { api, errMsg } from '../api.js';
import { store, loadSession } from '../store.js';
import { navigate } from '../router.js';
import { refreshChrome } from '../components.js';

const RESEND_MS = 30_000;

function pendingNext(query) {
  return typeof query.next === 'string' && query.next.startsWith('/') ? query.next : '/';
}

function loginHtml(query, state = {}) {
  const next = pendingNext(query);
  return (
    `<div class="auth-card">` +
      `<p class="kicker">Members</p>` +
      `<h1>Log in or sign up</h1>` +
      `<p>No password needed — we'll email you a sign-in link. New here? The same link creates your account.</p>` +
      (state.sent
        ? `<div class="auth-success">✓ Magic link sent to ${esc(state.sent)}. Check your inbox (and spam) — the link expires in 15 minutes.</div>`
        : '') +
      (state.error ? `<div class="auth-error">${esc(state.error)}</div>` : '') +
      `<form data-login-form>` +
        `<input type="hidden" name="next" value="${esc(next)}">` +
        `<label for="login-email">Email` +
          `<input type="email" id="login-email" name="email" required autocomplete="email" placeholder="you@example.com" value="${esc(state.email ?? '')}"></label>` +
        `<button class="btn btn-primary" type="submit" data-send-btn>Send sign-in link</button>` +
      `</form>` +
      (state.sent
        ? `<p class="meta" style="margin-top:1rem">Didn't get it? <button class="btn btn-sm" type="button" data-resend-btn>Resend</button></p>`
        : '') +
      `<p class="meta" style="margin-top:1.5rem"><a href="/">← Back to browsing</a></p>` +
    `</div>`
  );
}

function wireLogin(root, query) {
  const form = root.querySelector('[data-login-form]');
  if (!form) return;
  const emailInput = form.querySelector('#login-email');
  let email = emailInput.value;
  let sentAt = 0;
  const tick = () => {
    const resend = root.querySelector('[data-resend-btn]');
    if (resend) {
      const remaining = Math.ceil((RESEND_MS - (Date.now() - sentAt)) / 1000);
      resend.disabled = remaining > 0;
      resend.textContent = remaining > 0 ? `Resend in ${remaining}s` : 'Resend';
    }
  };
  const doSend = async () => {
    email = emailInput.value.trim();
    if (!email) {
      const card = root.querySelector('.auth-card');
      card.innerHTML = loginHtml(query, { error: 'Enter your email address.', email });
      wireLogin(root, query);
      return;
    }
    const sendBtn = form.querySelector('[data-send-btn]');
    sendBtn.disabled = true;
    sentAt = Date.now();
    const r = await api('/api/v1/auth/magic-link', { method: 'POST', body: { email }, loginRedirect: false });
    if (!r.ok) {
      const card = root.querySelector('.auth-card');
      card.innerHTML = loginHtml(query, {
        error: r.code === 'rate_limited' ? 'Too many attempts — wait a minute and try again.' : errMsg(r),
        email,
      });
      wireLogin(root, query);
      return;
    }
    const card = root.querySelector('.auth-card');
    card.innerHTML = loginHtml(query, { sent: email, email });
    wireLogin(root, query);
    root.querySelector('[data-resend-btn]')?.addEventListener('click', doSend);
    tick();
    const timer = setInterval(() => { tick(); if (Date.now() - sentAt > RESEND_MS) clearInterval(timer); }, 1000);
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); doSend(); });
  tick();
}

export function loginView({ query }) {
  if (store.user) { navigate(pendingNext(query)); return { title: 'Log in', html: '' }; }
  return {
    title: 'Log in',
    html: loginHtml(query),
    after(root) { wireLogin(root, query); },
  };
}

export async function verifyView({ query }) {
  const token = query.token;
  if (!token) {
    return {
      title: 'Invalid link',
      html: `<div class="auth-card"><p class="kicker">Members</p><h1>Invalid link</h1>` +
        `<div class="auth-error">This sign-in link is missing its token. Please request a new one.</div>` +
        `<p><a href="/auth/login">← Request a new link</a></p></div>`,
    };
  }
  const r = await api('/api/v1/auth/verify', { method: 'POST', body: { token }, loginRedirect: false });
  if (!r.ok) {
    const msg = r.code === 'rate_limited'
      ? 'Too many attempts — wait a minute and try again.'
      : r.code === 'invalid_token' || r.code === 'bad_request' || r.status === 400 || r.status === 422
        ? 'This link is invalid or has expired. Magic links expire after 15 minutes.'
        : errMsg(r);
    return {
      title: 'Sign-in failed',
      html: `<div class="auth-card"><p class="kicker">Members</p><h1>That didn't work</h1>` +
        `<div class="auth-error">${esc(msg)}</div>` +
        `<p><a href="/auth/login">← Request a new link</a></p></div>`,
    };
  }
  await loadSession();
  refreshChrome();
  const next = pendingNext(query);
  navigate(next);
  return {
    title: 'Signing you in',
    html: `<div class="auth-card"><p class="kicker">Members</p><h1>Signing you in…</h1><p class="meta">Taking you to where you were headed.</p></div>`,
  };
}
