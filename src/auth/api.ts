// src/auth/api.ts — passwordless auth primitives (magic-link issue/consume,
// user find-or-create, admin bootstrap). Pure .ts: no JSX imports, so node
// unit tests can import the v1 API router (src/api/v1.ts) without pulling
// in the SSR UI bundle. The HTML routes that render pages live in
// ./routes.ts (mountAuth) and re-export everything here.

import { newToken, sha256Hex } from './crypto';
import { sendMagicLink, type EmailEnv } from './email';
import { checkMagicLinkRate } from './rate_limit';

const MAGIC_LINK_TTL = "datetime('now', '+15 minutes')";
const SESSION_TTL = "datetime('now', '+30 days')";

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
 * every successful /auth/verify so later list edits promote existing users.
 * NEVER demotes: removing an email from the list does not revoke access
 * (revoke manually with
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

  // Single-use, enforced atomically: claim the token only if it is still
  // unused. Two concurrent redemptions cannot both win this UPDATE, so a
  // token can never mint more than one session.
  const claimed = await db
    .prepare(
      `UPDATE magic_tokens SET used_at = datetime('now')
        WHERE id = ?1 AND used_at IS NULL`,
    )
    .bind(row.id)
    .run();
  if (claimed.meta.changes !== 1) return null;

  const sessionToken = newToken();
  const sessionHash = await sha256Hex(sessionToken);
  await db
    .prepare(
      `INSERT INTO sessions (user_id, token_hash, expires_at)
       VALUES (?1, ?2, ${SESSION_TTL})`,
    )
    .bind(row.user_id, sessionHash)
    .run();
  return { sessionToken, userId: row.user_id };
}

/**
 * Magic-link sending budgets: max 5 links per email per rolling hour, max
 * 20 per source IP per rolling hour, max 500 site-wide per rolling hour.
 * The per-email limit prevents email-bombing; the IP and global budgets
 * bound the mail-provider cost/abuse blast radius of a fan-out attack.
 *
 * Re-exported here so existing import sites (src/api/v1.ts) keep working;
 * the implementation lives in ./rate_limit (import-free, unit-testable).
 */
export { checkMagicLinkRate };

/**
 * Sender-facing mail environment for issueMagicLink (the Email Service
 * binding). Re-exported so API callers can type their env the same way.
 */
export type { EmailEnv };
