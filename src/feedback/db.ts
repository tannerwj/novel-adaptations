// src/feedback/db.ts — Track D SQL: public feedback submissions, admin triage
// queue, and the per-IP hourly rate limit.
//
// Feedback rows may be anonymous (user_id NULL); the optional email field on
// the form is the reporter's own address, NOT looked-up account data, so it
// is safe to show in the admin list (constraint: never expose other users'
// emails — no join to users happens here at all).

export type FeedbackType = 'feature' | 'adaptation_tip' | 'correction' | 'other';
export type FeedbackStatus = 'new' | 'reviewed' | 'done';

export const FEEDBACK_TYPES: FeedbackType[] = [
  'feature',
  'adaptation_tip',
  'correction',
  'other',
];
export const FEEDBACK_STATUSES: FeedbackStatus[] = ['new', 'reviewed', 'done'];

export interface FeedbackRow {
  id: number;
  user_id: number | null;
  email: string | null;
  type: FeedbackType;
  subject: string;
  body: string;
  proof_url: string | null;
  status: FeedbackStatus;
  created_at: string;
}

export interface CreateFeedbackInput {
  userId: number | null;
  email: string | null;
  type: FeedbackType;
  subject: string;
  body: string;
  proofUrl: string | null;
}

export interface ListFeedbackFilters {
  type?: FeedbackType;
  status?: FeedbackStatus;
}

/** Insert a feedback submission. Returns the new row id. */
export async function createFeedback(
  db: D1Database,
  input: CreateFeedbackInput,
): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO feedback (user_id, email, type, subject, body, proof_url)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
    .bind(input.userId, input.email, input.type, input.subject, input.body, input.proofUrl)
    .run();
  const id = Number(result.meta.last_row_id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('failed to create feedback');
  }
  return id;
}

/** List feedback newest first, with optional type/status filters. */
export async function listFeedback(
  db: D1Database,
  filters: ListFeedbackFilters = {},
): Promise<FeedbackRow[]> {
  const conditions: string[] = [];
  const binds: (string | null)[] = [];
  if (filters.type) {
    conditions.push('type = ?' + (binds.length + 1));
    binds.push(filters.type);
  }
  if (filters.status) {
    conditions.push('status = ?' + (binds.length + 1));
    binds.push(filters.status);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const { results } = await db
    .prepare(
      `SELECT id, user_id, email, type, subject, body, proof_url, status, created_at
         FROM feedback
         ${where}
        ORDER BY id DESC`,
    )
    .bind(...binds)
    .all<FeedbackRow>();
  return results;
}

/** Triage a feedback item. Caller validates the status value. */
export async function setFeedbackStatus(
  db: D1Database,
  id: number,
  status: FeedbackStatus,
): Promise<boolean> {
  const result = await db
    .prepare('UPDATE feedback SET status = ?1 WHERE id = ?2')
    .bind(status, id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function getFeedback(db: D1Database, id: number): Promise<FeedbackRow | null> {
  const row = await db
    .prepare(
      `SELECT id, user_id, email, type, subject, body, proof_url, status, created_at
         FROM feedback
        WHERE id = ?1`,
    )
    .bind(id)
    .first<FeedbackRow>();
  return row ?? null;
}

/** Count feedback rows per status (for the admin queue tabs). */
export async function countFeedbackByStatus(
  db: D1Database,
): Promise<Record<FeedbackStatus, number>> {
  const { results } = await db
    .prepare('SELECT status, COUNT(*) AS n FROM feedback GROUP BY status')
    .all<{ status: FeedbackStatus; n: number }>();
  const counts: Record<FeedbackStatus, number> = {
    new: 0,
    reviewed: 0,
    done: 0,
  };
  for (const row of results) {
    if (FEEDBACK_STATUSES.includes(row.status)) counts[row.status] = row.n;
  }
  return counts;
}

// --- rate limiting ------------------------------------------------------------

/** Feedback rate limit: max 5 submissions per IP per rolling hour. */
const FEEDBACK_HOURLY_LIMIT = 5;

/**
 * Returns true when the submission is allowed (and records it), false when
 * the IP has hit the hourly limit. Mirrors checkMagicLinkRate in
 * src/auth/routes.ts: one row per (ip, UTC hour), upsert-increment.
 */
export async function checkFeedbackRate(db: D1Database, ip: string): Promise<boolean> {
  const hour = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH (UTC)
  const row = await db
    .prepare('SELECT count FROM feedback_rate WHERE ip = ?1 AND hour = ?2')
    .bind(ip, hour)
    .first<{ count: number }>();
  if (row && row.count >= FEEDBACK_HOURLY_LIMIT) return false;
  await db
    .prepare(
      `INSERT INTO feedback_rate (ip, hour, count) VALUES (?1, ?2, 1)
       ON CONFLICT(ip, hour) DO UPDATE SET count = count + 1`,
    )
    .bind(ip, hour)
    .run();
  return true;
}

/**
 * Best-effort client IP for rate limiting: cf-connecting-ip on Cloudflare,
 * falling back to the first entry of x-forwarded-for, else 'unknown'.
 */
export function clientIp(headers: Headers): string {
  const direct = headers.get('cf-connecting-ip');
  if (direct) return direct.trim();
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return 'unknown';
}
