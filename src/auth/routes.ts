// src/auth/routes.ts — passwordless auth (magic-link) routes.
//
//   GET  /auth/login       — sign-in form (LoginPage)
//   POST /auth/magic-link  — email form → magic link (sent via Cloudflare Email
//                           Service, or shown on a dev page when no sender is
//                           configured)
//   GET  /auth/verify      — single-use token → 30-day httpOnly session
//   POST /auth/logout      — destroy session, clear cookie
//
// NOTE: page components are called as plain functions (no JSX) so this file
// stays .ts. `LoginPage({})` is exactly what `<LoginPage />` desugars to.

import type { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Env } from '../index';
import { AuthErrorPage, LoginPage, MagicLinkSentPage, themeOf } from '../ui';
import { newToken, sha256Hex } from './crypto';
import { sendMagicLink, type EmailEnv } from './email';
import { SESSION_COOKIE } from './session';

/** Bindings for the auth routes (EMAIL send binding comes from Env). */
export interface AuthBindings extends Env {
  /** 'development' shows magic links on-screen when email is unconfigured. Unset/anything else → fail closed. */
  ENVIRONMENT?: string;
}

const MAGIC_LINK_TTL = "datetime('now', '+15 minutes')";
const SESSION_TTL = "datetime('now', '+30 days')";
const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30 days in seconds

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Magic-link rate limit: max 5 links per email per rolling hour. Prevents
 * email-bombing / provider cost abuse via the public /auth/magic-link endpoint.
 */
const MAGIC_LINK_HOURLY_LIMIT = 5;
export async function checkMagicLinkRate(db: D1Database, email: string): Promise<boolean> {
  const hour = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH (UTC)
  const row = await db
    .prepare('SELECT count FROM magic_link_rate WHERE email = ?1 AND hour = ?2')
    .bind(email, hour)
    .first<{ count: number }>();
  if (row && row.count >= MAGIC_LINK_HOURLY_LIMIT) return false;
  await db
    .prepare(
      `INSERT INTO magic_link_rate (email, hour, count) VALUES (?1, ?2, 1)
       ON CONFLICT(email, hour) DO UPDATE SET count = count + 1`,
    )
    .bind(email, hour)
    .run();
  return true;
}

export async function findOrCreateUser(db: D1Database, email: string): Promise<number> {
  const existing = await db
    .prepare('SELECT id FROM users WHERE email = ?1')
    .bind(email)
    .first<{ id: number }>();
  if (existing) return existing.id;
  // Race-safe: two concurrent signups for the same email collapse here.
  await db
    .prepare('INSERT INTO users (email) VALUES (?1) ON CONFLICT(email) DO NOTHING')
    .bind(email)
    .run();
  const row = await db
    .prepare('SELECT id FROM users WHERE email = ?1')
    .bind(email)
    .first<{ id: number }>();
  if (!row) throw new Error('failed to create user');
  return row.id;
}

/**
 * Admin bootstrap — the ONLY promotion path in the codebase.
 *
 * ADMIN_EMAILS is a comma-separated allow-list of owner emails (set via
 * `wrangler secret put ADMIN_EMAILS`). Both sides are normalized (trim +
 * lowercase); empties are dropped. On match, grants is_admin=1. Runs on
 * every successful /auth/verify so later list edits promote existing
 * users. NEVER demotes: removing an email from the list does not revoke
 * access (revoke manually with
 *   UPDATE users SET is_admin = 0 WHERE email = '…';).
 * No route, API, or UI may mutate is_admin.
 */
export async function promoteAdmin(
  db: D1Database,
  adminEmails: string | undefined,
  userId: number,
): Promise<void> {
  const allowList = (adminEmails ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
  if (allowList.length === 0) return;
  const row = await db
    .prepare('SELECT email FROM users WHERE id = ?1')
    .bind(userId)
    .first<{ email: string }>();
  if (!row) return;
  if (allowList.includes(row.email.trim().toLowerCase())) {
    await db
      .prepare('UPDATE users SET is_admin = 1 WHERE id = ?1')
      .bind(userId)
      .run();
  }
}

/**
 * Issue a magic link for an email: find-or-create the user, store a hashed
 * single-use token (15-min TTL), and attempt delivery via the Email Service.
 * Shared by the legacy HTML route and the v1 JSON API (src/api/v1.ts).
 * Returns whether the email was actually sent and the link itself (the
 * caller decides whether the on-screen dev link is safe to show).
 */
export async function issueMagicLink(
  db: D1Database,
  env: EmailEnv,
  email: string,
  origin: string,
): Promise<{ sent: boolean; link: string }> {
  const userId = await findOrCreateUser(db, email);
  const token = newToken();
  const tokenHash = await sha256Hex(token);
  await db
    .prepare(
      `INSERT INTO magic_tokens (user_id, token_hash, expires_at)
       VALUES (?1, ?2, ${MAGIC_LINK_TTL})`,
    )
    .bind(userId, tokenHash)
    .run();

  const link = `${origin}/auth/verify?token=${encodeURIComponent(token)}`;
  const { sent } = await sendMagicLink(env, email, link);
  return { sent, link };
}

/**
 * Consume a single-use magic token and create a 30-day session.
 * Returns the raw session token (to set as the na_session cookie) and the
 * owning user id — or null when the token is missing, expired, or used.
 * Shared by the legacy HTML route and the v1 JSON API (src/api/v1.ts).
 */
export async function consumeMagicToken(
  db: D1Database,
  token: string,
): Promise<{ sessionToken: string; userId: number } | null> {
  const tokenHash = await sha256Hex(token);
  const row = await db
    .prepare(
      `SELECT id, user_id FROM magic_tokens
        WHERE token_hash = ?1
          AND used_at IS NULL
          AND expires_at > datetime('now')`,
    )
    .bind(tokenHash)
    .first<{ id: number; user_id: number }>();

  if (!row) return null;

  // Single-use: mark consumed before issuing the session.
  const sessionToken = newToken();
  const sessionHash = await sha256Hex(sessionToken);
  await db.batch([
    db.prepare("UPDATE magic_tokens SET used_at = datetime('now') WHERE id = ?1").bind(
      row.id,
    ),
    db
      .prepare(
        `INSERT INTO sessions (user_id, token_hash, expires_at)
         VALUES (?1, ?2, ${SESSION_TTL})`,
      )
      .bind(row.user_id, sessionHash),
  ]);
  return { sessionToken, userId: row.user_id };
}

/**
 * Sender-facing mail environment for issueMagicLink (the Email Service
 * binding). Re-exported so API callers can type their env the same way.
 */
export type { EmailEnv };

export function mountAuth<E extends AuthBindings>(app: Hono<{ Bindings: E }>): void {
  app.get('/auth/login', (c) => {
    return c.html(LoginPage({ theme: themeOf(c) }));
  });

  app.post('/auth/magic-link', async (c) => {
    let email = '';
    try {
      const body = await c.req.parseBody();
      const raw = body['email'];
      email = (typeof raw === 'string' ? raw : '').trim().toLowerCase();
    } catch {
      email = '';
    }
    if (!EMAIL_RE.test(email)) {
      return c.html(LoginPage({ error: 'Enter a valid email address.', theme: themeOf(c) }), 400);
    }

    if (!(await checkMagicLinkRate(c.env.DB, email))) {
      return c.html(
        LoginPage({ error: 'Too many sign-in emails — try again in an hour.', theme: themeOf(c) }),
        429,
      );
    }

    const origin = new URL(c.req.url).origin;
    const { sent, link } = await issueMagicLink(c.env.DB, c.env, email, origin);

    if (sent) {
      return c.html(MagicLinkSentPage({ email, theme: themeOf(c) }));
    }
    // Fail closed: the on-screen link is a local-dev convenience ONLY, shown
    // when ENVIRONMENT is explicitly non-production. In production (or when
    // unset) an unconfigured mailer is a hard error, never a leaked link.
    const devMode = c.env.ENVIRONMENT === 'development' || c.env.ENVIRONMENT === 'preview';
    if (devMode) {
      return c.html(MagicLinkSentPage({ email, devLink: link, theme: themeOf(c) }));
    }
    return c.html(
      AuthErrorPage({
        message:
          'Sign-in email is not configured yet. Ask the site owner to onboard a sending domain in Email Service.',
        theme: themeOf(c),
      }),
      503,
    );
  });

  app.get('/auth/verify', async (c) => {
    const token = c.req.query('token') ?? '';
    if (!token) {
      return c.html(
        AuthErrorPage({ message: 'This sign-in link is invalid or expired.', theme: themeOf(c) }),
        400,
      );
    }
    const consumed = await consumeMagicToken(c.env.DB, token);
    if (!consumed) {
      return c.html(
        AuthErrorPage({
          message: 'This sign-in link is invalid, expired, or already used.',
          theme: themeOf(c),
        }),
        400,
      );
    }

    // Single-use: mark consumed before issuing the session.
    const sessionToken = consumed.sessionToken;
    const userId = consumed.userId;

    // Admin bootstrap (the ONLY promotion path in the codebase): if the
    // sign-in email is on the ADMIN_EMAILS allow-list, grant is_admin. Runs
    // on every successful verify so later list edits promote existing users.
    // NEVER demotes — removing an email from ADMIN_EMAILS does not revoke
    // access; revoke manually via SQL if needed. See migration 0007.
    await promoteAdmin(c.env.DB, c.env.ADMIN_EMAILS, userId);

    const secure = new URL(c.req.url).protocol === 'https:';
    setCookie(c, SESSION_COOKIE, sessionToken, {
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
      secure,
      maxAge: SESSION_MAX_AGE,
    });
    return c.redirect('/', 303);
  });

  app.post('/auth/logout', async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) {
      const tokenHash = await sha256Hex(token);
      await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1')
        .bind(tokenHash)
        .run();
    }
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.redirect('/', 303);
  });
}
