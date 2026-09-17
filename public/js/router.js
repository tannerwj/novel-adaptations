// public/js/router.js — History-API router. No full-page reloads, ever.
//
// - `routes` maps pathname patterns to view functions. Views return
//   {title, html} (or a Promise of it), and may provide `after(root)` to
//   wire events after insertion.
// - Link interception: same-origin GET clicks on <a href> navigate without
//   reloading; external links, new-tab clicks, and downloads are untouched.
// - Form interception: forms with `data-spa` are handled by their view's
//   `after()` wiring; everything else submits normally (there are no plain
//   full-POST forms in the SPA, but the guard keeps the header search
//   working if JS partially fails).
// - Each navigation renders a loading skeleton, runs the view, then swaps
//   #app. A navigation token discards stale async renders.

import { isAdmin, isAuthed, store } from './store.js';
import { isAuthRedirect } from './api.js';

const app = () => document.getElementById('app');

/** Registered lazily to avoid import cycles with views. */
let routes = [];

export function registerRoutes(table) {
  routes = table;
}

function matchRoute(pathname) {
  for (const r of routes) {
    const m = pathname.match(r.pattern);
    if (m) return { view: r.view, params: m.groups || {}, auth: r.auth, admin: r.admin };
  }
  return null;
}

let navToken = 0;

function loadingHtml() {
  return `<div class="view-loading" role="status" aria-live="polite"><span class="spinner" aria-hidden="true"></span><span>Loading…</span></div>`;
}

export function errorHtml(title, heading, message, cta) {
  return (
    `<div class="view-error page-narrow">` +
      `<p class="kicker">Hmm</p>` +
      `<h1 class="display-title">${heading}</h1>` +
      `<p class="lede">${message}</p>` +
      (cta || `<p class="center" style="margin-top:1.75rem"><a class="btn btn-primary" href="/">← Back to all adaptations</a></p>`) +
    `</div>`
  );
}

export function renderError(title, heading, message, cta) {
  const root = app();
  document.title = `${title} — Novel Adaptations`;
  root.innerHTML = errorHtml(title, heading, message, cta);
}

export function notFoundHtml() {
  return errorHtml('Not found', 'Page not found', 'That page doesn’t exist. It may have moved, or the link may be wrong.');
}

export function renderNotFound() {
  renderError('Not found', 'Page not found', 'That page doesn’t exist. It may have moved, or the link may be wrong.');
}

function renderForbidden() {
  renderError('Forbidden', 'Not for you', 'This area is for the site owner. If that’s you, make sure you’re signed in with the right account.');
}

export async function render() {
  const token = ++navToken;
  const url = new URL(window.location.href);
  const pathname = url.pathname;
  const matched = matchRoute(pathname);

  // Auth gates mirror the old server behavior: logged-out → /auth/login?next=…,
  // logged-in non-admin → 403 view.
  if (matched && matched.auth && !isAuthed()) {
    navigate('/auth/login?next=' + encodeURIComponent(pathname + url.search), { replace: true });
    return;
  }
  if (matched && matched.admin && !isAdmin()) {
    if (!isAuthed()) {
      navigate('/auth/login?next=' + encodeURIComponent(pathname + url.search), { replace: true });
    } else {
      renderForbidden();
    }
    return;
  }

  const root = app();
  root.innerHTML = loadingHtml();
  window.scrollTo(0, 0);

  try {
    if (!matched) {
      renderNotFound();
      return;
    }
    const query = Object.fromEntries(url.searchParams.entries());
    const out = await matched.view({ params: matched.params, query, pathname });
    if (token !== navToken) return; // a newer navigation won
    document.title = `${out.title} — Novel Adaptations`;
    root.innerHTML = out.html;
    if (out.after) out.after(root);
    if (navigatedHook) navigatedHook(pathname);
  } catch (e) {
    if (isAuthRedirect(e)) return; // api() already sent us to /auth/login
    if (token !== navToken) return;
    console.error('[router] view failed:', e);
    renderError('Error', 'Something went wrong', 'The page couldn’t load. Try again in a moment.');
  }
}

/** Client-side navigation: pushState + render, no reload. */
export function navigate(path, opts = {}) {
  const url = new URL(path, window.location.origin);
  if (opts.replace) window.history.replaceState(null, '', url.pathname + url.search);
  else window.history.pushState(null, '', url.pathname + url.search);
  render();
}

/** Update the address bar query (e.g. live search) without a new history entry. */
export function replaceQuery(path) {
  const url = new URL(path, window.location.origin);
  window.history.replaceState(null, '', url.pathname + url.search);
}

function isLocalHref(a) {
  if (!a || a.target === '_blank') return false;
  const href = a.getAttribute('href');
  if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return false;
  try {
    const u = new URL(href, window.location.origin);
    return u.origin === window.location.origin;
  } catch {
    return false;
  }
}

/** Boot the router: intercept clicks, handle back/forward, render. */
export function startRouter() {
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest('a[href]');
    if (!a || !isLocalHref(a)) return;
    e.preventDefault();
    const href = a.getAttribute('href');
    if (href !== window.location.pathname + window.location.search) navigate(href);
  });
  window.addEventListener('popstate', () => render());
  render();
}

/** Re-render the current route in place (after login/logout/theme-independent state changes). */
export function rerender() {
  render();
}

/** Hook called after every successful view render (e.g. to refresh chrome). */
let navigatedHook = null;
export function onNavigated(fn) {
  navigatedHook = fn;
}
