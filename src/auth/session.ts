// src/auth/session.ts — read the logged-in user from the na_session cookie.
// Sessions are long-lived (30 days), httpOnly, and stored as hashes in D1.

import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { sha256Hex } from './crypto';

export const SESSION_COOKIE = 'na_session';

export interface SessionUser {
  id: number;
  email: string;
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
    `SELECT u.id AS id, u.email AS email
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
