// tests/e2e/helpers.mjs — shared HTTP, assertions, mini-runner, and the
// client-view loader for the Novel Adaptations E2E regression suite.
//
// The "front-end" angle: the SPA's views (public/js/views/*.js) are pure
// renderers — async functions that fetch /api/v1 and return {title, html}.
// loadClientViews() imports the REAL client modules into Node, rewires
// global fetch to hit BASE_URL (with the test session cookie), and lets
// tests assert on the exact HTML strings users see after first paint.

const computeBase = () =>
  (process.env.BASE_URL || 'https://noveladaptations.com').replace(/\/$/, '');

export let BASE = computeBase();

/**
 * Re-read BASE_URL into the live BASE binding. run.mjs imports this module
 * before parsing --base, so it calls this after argument parsing; every
 * importer sees the updated value through the live binding.
 */
export function refreshBaseFromEnv() {
  BASE = computeBase();
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function buildHeaders({ session, cookie, ua, extra } = {}) {
  const h = new Headers(extra || {});
  if (session) h.set('cookie', `na_session=${session}`);
  else if (cookie) h.set('cookie', cookie);
  if (ua) h.set('user-agent', ua);
  return h;
}

/** Raw page fetch: returns {status, text}. */
export async function getPage(path, opts = {}) {
  const res = await fetch(BASE + path, {
    headers: buildHeaders(opts),
    redirect: 'manual',
  });
  return { status: res.status, text: await res.text() };
}

/** Redirect check: follows nothing, returns {status, location}. */
export async function getRedirect(path, opts = {}) {
  const res = await fetch(BASE + path, {
    headers: buildHeaders(opts),
    redirect: 'manual',
  });
  await res.text().catch(() => {});
  return { status: res.status, location: res.headers.get('location') };
}

/** JSON API fetch: returns {status, data}. Never throws on HTTP errors. */
export async function api(method, path, { session, body, query } = {}) {
  const url = BASE + path + (query ? '?' + new URLSearchParams(query).toString() : '');
  const res = await fetch(url, {
    method,
    headers: buildHeaders({ session, extra: { 'content-type': 'application/json', accept: 'application/json' } }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

export const apiGet = (path, opts) => api('GET', path, opts);
export const apiPost = (path, opts) => api('POST', path, opts);
export const apiPut = (path, opts) => api('PUT', path, opts);
export const apiDel = (path, opts) => api('DELETE', path, opts);

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

export class AssertError extends Error {}

export function assert(cond, msg) {
  if (!cond) throw new AssertError(msg);
}
export function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new AssertError(`${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
export function contains(haystack, needle, msg) {
  if (!String(haystack).includes(needle)) {
    throw new AssertError(`${msg} — expected to find ${JSON.stringify(needle.slice(0, 80))}`);
  }
}
export function notContains(haystack, needle, msg) {
  if (String(haystack).includes(needle)) {
    throw new AssertError(`${msg} — did not expect to find ${JSON.stringify(needle.slice(0, 80))}`);
  }
}
export function countOccurrences(haystack, needle) {
  const s = String(haystack);
  let n = 0, i = 0;
  while ((i = s.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

// ---------------------------------------------------------------------------
// Mini test runner
// ---------------------------------------------------------------------------

export function test(name, fn) {
  return { name, fn };
}

export async function runTests(label, tests, ctx) {
  console.log(`\n## ${label} (${tests.length} flows)`);
  let passed = 0;
  const failed = [];
  for (const t of tests) {
    try {
      await t.fn(ctx);
      passed++;
      console.log(`  ✓ ${t.name}`);
    } catch (e) {
      failed.push(t.name);
      console.log(`  ✗ ${t.name}`);
      console.log(`    ${e instanceof AssertError ? e.message : 'ERROR: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e))}`);
    }
  }
  return { passed, failed };
}

// ---------------------------------------------------------------------------
// Client views (real SPA renderers, executed in Node)
// ---------------------------------------------------------------------------

let clientCache = null;

/**
 * Import the actual client view modules and rewire fetch so their relative
 * /api/v1 calls hit BASE (with the test session cookie when provided).
 * Also installs minimal window/document shims: view render paths are pure
 * string builders, so any DOM touch during render fails loudly instead of
 * silently passing.
 */
export async function loadClientViews({ base = BASE, session = null } = {}) {
  if (clientCache && clientCache.session === session) return clientCache.views;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (typeof url === 'string' && url.startsWith('/')) {
      const headers = new Headers(opts.headers || {});
      if (session) headers.set('cookie', `na_session=${session}`);
      return realFetch(base + url, { ...opts, headers });
    }
    return realFetch(url, opts);
  };
  if (typeof globalThis.window === 'undefined') {
    globalThis.window = {
      location: { pathname: '/', search: '', origin: base },
    };
  }
  if (typeof globalThis.document === 'undefined') {
    globalThis.document = new Proxy(
      {},
      {
        get: (_t, prop) => {
          throw new Error(`e2e: client render unexpectedly touched document.${String(prop)}`);
        },
      },
    );
  }
  const root = new URL('../../public/js/', import.meta.url);
  const mod = (p) => import(new URL(p, root).href);
  const [home, detail, listsViews, widgets, storeMod] = await Promise.all([
    mod('views/home.js'),
    mod('views/detail.js'),
    mod('views/lists.js'),
    mod('widgets.js'),
    mod('store.js'),
  ]);
  // Reset store to a known logged-out state; callers set authed state.
  storeMod.store.user = null;
  storeMod.store.sessionLoaded = false;
  clientCache = { session, views: { home, detail, listsViews, widgets, store: storeMod.store } };
  return clientCache.views;
}

/** Mark the client store as logged-in (mirrors what the SPA does after /auth/me). */
export function setClientAuthed(store, user) {
  store.user = { id: user.id, email: user.email, is_admin: false };
  store.sessionLoaded = true;
}
