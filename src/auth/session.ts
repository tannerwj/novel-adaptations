// src/auth/session.ts — read the logged-in user from the na_session cookie.
// Sessions are long-lived (30 days), httpOnly, and stored as hashes in D1.

import type { Context, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import { sha256Hex } from './crypto';

export const SESSION_COOKIE = 'na_session';

export interface SessionUser {
  id: number;
  email: string;
  /** True when the user is an owner/admin (users.is_admin = 1). */
  isAdmin: boolean;
}

type DbBindings = { DB: D1Database };

/** The authenticated user, or null when logged out / session expired. */
export async function getUser<E extends DbBindings>(
  c: Context<{ Bindings: E }>,
): Promise<SessionUser | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await c.env.DB.prepare(
    `SELECT u.id AS id, u.email AS email, u.is_admin AS isAdmin
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?1
        AND s.expires_at > datetime('now')`,
  )
    .bind(tokenHash)
    .first<SessionUser>();
  return row ?? null;
}

/**
 * Same as getUser. Handlers decide what "not logged in" means
 * (401 JSON for APIs, redirect to /auth/login for pages).
 */
export async function requireUser<E extends DbBindings>(
  c: Context<{ Bindings: E }>,
): Promise<SessionUser | null> {
  return getUser(c);
}

/**
 * Admin gate for page routes (/admin/*). Fail closed: logged-out → 303 to
 * /auth/login; logged in but not an admin → 403.
 */
export async function requireAdminPage<E extends DbBindings>(
  c: Context<{ Bindings: E }>,
  next: Next,
): Promise<Response | void> {
  const user = await getUser(c);
  if (!user) return c.redirect('/auth/login', 303);
  if (!user.isAdmin) return c.text('Forbidden — admin access required.', 403);
  await next();
}

/**
 * Admin gate for API routes (/api/news/*). Fail closed: anything that isn't
 * an authenticated admin session → 403 JSON.
 */
export async function requireAdminApi<E extends DbBindings>(
  c: Context<{ Bindings: E }>,
  next: Next,
): Promise<Response | void> {
  const user = await getUser(c);
  if (!user || !user.isAdmin) {
    return c.json({ error: 'Forbidden — admin access required.' }, 403);
  }
  await next();
}
