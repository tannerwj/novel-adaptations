// public/js/api.js — JSON API client for /api/v1.
//
// - Every request sends `credentials: 'same-origin'` so the HttpOnly
//   `na_session` cookie rides along (there is no bearer-token mode).
// - All error responses use the `{error:{code,message}}` envelope; failed
//   calls resolve to {ok:false, status, data, code, message} instead of
//   throwing — views render `message` inline.
// - On 401 the SPA sends the user to /auth/login preserving the target
//   (unless the caller opts out with loginRedirect:false), then throws a
//   sentinel the router swallows so views stop mid-flow cleanly.

import { navigate } from './router.js';

export const AUTH_REDIRECT = '__na_auth_redirect__';

export function isAuthRedirect(err) {
  return err instanceof Error && err.message === AUTH_REDIRECT;
}

export async function api(path, opts = {}) {
  const { method = 'GET', body, loginRedirect = true } = opts;
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    // Network-level failure (offline, DNS, …) — no envelope to read.
    return { ok: false, status: 0, data: {}, code: 'network_error', message: 'Could not reach the server. Check your connection and try again.' };
  }
  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  if (res.status === 401 && loginRedirect) {
    const next = window.location.pathname + window.location.search;
    navigate('/auth/login?next=' + encodeURIComponent(next));
    throw new Error(AUTH_REDIRECT);
  }
  const err = data && data.error ? data.error : {};
  return {
    ok: res.ok,
    status: res.status,
    data,
    code: res.ok ? null : (err.code || `http_${res.status}`),
    message: res.ok ? null : (err.message || `Request failed (${res.status}).`),
  };
}

/** Extract the human message from a failed api() result. */
export function errMsg(r, fallback = 'Something went wrong. Please try again.') {
  return (r && r.message) || fallback;
}
