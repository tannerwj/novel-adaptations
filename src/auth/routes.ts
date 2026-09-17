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
// The pure auth primitives live in ./api.ts (node-importable); this module
// re-exports them so existing import sites keep working.

import type { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Env } from '../index';
import { AuthErrorPage, LoginPage, MagicLinkSentPage, themeOf } from '../ui';
import { sha256Hex } from './crypto';
import { clientIp } from '../feedback/db';
import { SESSION_COOKIE } from './session';
import {
  checkMagicLinkRate,
  consumeMagicToken,
  findOrCreateUser,
  issueMagicLink,
  promoteAdmin,
  type EmailEnv,
} from './api';

export {
  checkMagicLinkRate,
  consumeMagicToken,
  findOrCreateUser,
  issueMagicLink,
  promoteAdmin,
  type EmailEnv,
};

/** Bindings for the auth routes (EMAIL send binding comes from Env). */
export interface AuthBindings extends Env {
  /** 'development' shows magic links on-screen when email is unconfigured. Unset/anything else → fail closed. */
  ENVIRONMENT?: string;
}

const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30 days in seconds

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;


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

    if (!(await checkMagicLinkRate(c.env.DB, email, clientIp(c.req.raw.headers)))) {
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
