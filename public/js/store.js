// public/js/store.js — tiny client state: session user + theme.
//
// The session is the HttpOnly na_session cookie; the store mirrors the
// decoded user ({id, email, is_admin}) from GET /api/v1/auth/me so views
// can gate without a round-trip. Theme is the 1-year `theme` cookie,
// mirrored on <html data-theme> and the theme-color meta.

import { api } from './api.js';

export const THEME_LIGHT_META = '#faf9f6';
export const THEME_DARK_META = '#0b0c10';

export const store = {
  /** {id, email, is_admin} | null */
  user: null,
  sessionLoaded: false,
  theme: 'light',
};

function readThemeCookie() {
  const m = document.cookie.match(/(?:^|;\s*)theme=(light|dark)/);
  return m ? m[1] : 'light';
}

function applyThemeToDom(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? THEME_DARK_META : THEME_LIGHT_META);
  document.querySelectorAll('[data-theme-icon="sun"]').forEach((el) => { el.hidden = theme !== 'dark'; });
  document.querySelectorAll('[data-theme-icon="moon"]').forEach((el) => { el.hidden = theme === 'dark'; });
  document.querySelectorAll('.theme-toggle').forEach((btn) => {
    const label = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
    btn.setAttribute('aria-label', label);
    btn.setAttribute('title', label);
  });
}

/** Sync store.theme from the cookie (set by the inline head script pre-paint). */
export function initTheme() {
  store.theme = readThemeCookie();
  applyThemeToDom(store.theme);
}

/**
 * Instant theme toggle: flip the DOM immediately, then persist via
 * POST /api/v1/theme (which sets the 1-year shared cookie). Rolls back the
 * DOM on failure. Never reloads.
 */
export async function toggleTheme() {
  const next = store.theme === 'dark' ? 'light' : 'dark';
  const prev = store.theme;
  store.theme = next;
  applyThemeToDom(next);
  const r = await api('/api/v1/theme', { method: 'POST', body: { theme: next }, loginRedirect: false });
  if (!r.ok) {
    // Roll back: the cookie is the source of truth.
    store.theme = prev;
    applyThemeToDom(prev);
  }
  return r;
}

/**
 * Load (or reload) the session user. Never redirects; 401 just means logged
 * out. On the first boot after a full page load the worker embeds the
 * session user as window.__naUser (src/spa/shell.ts) — use it and skip the
 * /api/v1/auth/me round trip on the critical path. Explicit reloads (e.g.
 * after login) still hit the API.
 */
export async function loadSession() {
  if (!store.sessionLoaded && typeof window !== 'undefined' && window.__naUser !== undefined) {
    const boot = window.__naUser;
    delete window.__naUser;
    store.user = boot && typeof boot === 'object' ? boot : null;
    store.sessionLoaded = true;
    return store.user;
  }
  const r = await api('/api/v1/auth/me', { loginRedirect: false });
  store.user = r.ok && r.data && r.data.user ? r.data.user : null;
  store.sessionLoaded = true;
  return store.user;
}

export function isAuthed() {
  return !!store.user;
}

/**
 * Auth gate for rendering interactive auth-gated markup (rating stars, hype
 * segments, review forms, …). The SPA resolves the session before the first
 * render, so in practice this equals isAuthed() — but requiring
 * sessionLoaded too makes logged-out rendering deterministic: a view can
 * never flash the signed-in variant of a widget before the session is
 * actually known.
 */
export function isAuthedResolved() {
  return store.sessionLoaded && !!store.user;
}

export function isAdmin() {
  return !!store.user && !!store.user.is_admin;
}

export function logoutLocal() {
  store.user = null;
}
