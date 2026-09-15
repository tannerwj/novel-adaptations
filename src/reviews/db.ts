// src/reviews/db.ts — Track 2 SQL: spoiler-safe user reviews.
// (src/db.ts is owned by others — DO NOT EDIT it.)

export type ReviewTargetType = 'book' | 'screen_work';

export const REVIEW_TARGET_TYPES: ReviewTargetType[] = ['book', 'screen_work'];

/** A review row joined with its author's identity. */
export interface Review {
  id: number;
  userId: number;
  targetType: ReviewTargetType;
  targetId: number;
  title: string | null;
  body: string;
  hasSpoilers: boolean;
  createdAt: string;
  updatedAt: string;
  authorId: number;
  authorEmail: string;
}

/** Column aliasing is explicit so D1 returns camelCase keys directly. */
const SELECT_REVIEWS = `
  SELECT r.id, r.user_id AS userId, r.target_type AS targetType,
         r.target_id AS targetId, r.title, r.body,
         r.has_spoilers AS hasSpoilers,
         r.created_at AS createdAt, r.updated_at AS updatedAt,
         u.id AS authorId, u.email AS authorEmail
    FROM reviews r
    JOIN users u ON u.id = r.user_id
`;

/** Raw D1 row: has_spoilers arrives as SQLite 0/1, mapped below. */
interface ReviewRow {
  id: number;
  userId: number;
  targetType: ReviewTargetType;
  targetId: number;
  title: string | null;
  body: string;
  hasSpoilers: number;
  createdAt: string;
  updatedAt: string;
  authorId: number;
  authorEmail: string;
}

function toReview(r: ReviewRow): Review {
  return { ...r, hasSpoilers: r.hasSpoilers === 1 };
}

/** Reviews for one target, newest first. Author identity included. */
export async function listReviews(
  db: D1Database,
  targetType: ReviewTargetType,
  targetId: number,
): Promise<Review[]> {
  const { results } = await db
    .prepare(`${SELECT_REVIEWS} WHERE r.target_type = ?1 AND r.target_id = ?2 ORDER BY r.id DESC`)
    .bind(targetType, targetId)
    .all<ReviewRow>();
  return (results ?? []).map(toReview);
}

/** A single review, or null. */
export async function getReview(db: D1Database, id: number): Promise<Review | null> {
  const row = await db
    .prepare(`${SELECT_REVIEWS} WHERE r.id = ?1`)
    .bind(id)
    .first<ReviewRow>();
  return row ? toReview(row) : null;
}

/** The caller's own review for a target, if any (one review per user per item). */
export async function getUserReview(
  db: D1Database,
  userId: number,
  targetType: ReviewTargetType,
  targetId: number,
): Promise<Review | null> {
  const row = await db
    .prepare(
      `${SELECT_REVIEWS} WHERE r.user_id = ?1 AND r.target_type = ?2 AND r.target_id = ?3`,
    )
    .bind(userId, targetType, targetId)
    .first<ReviewRow>();
  return row ? toReview(row) : null;
}

/** Insert a review; returns its id. Caller guarantees no duplicate exists. */
export async function createReview(
  db: D1Database,
  userId: number,
  targetType: ReviewTargetType,
  targetId: number,
  title: string | null,
  body: string,
  hasSpoilers: boolean,
): Promise<number> {
  const res = await db
    .prepare(
      `INSERT INTO reviews (user_id, target_type, target_id, title, body, has_spoilers)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
    .bind(userId, targetType, targetId, title, body, hasSpoilers ? 1 : 0)
    .run();
  const id = res.meta?.last_row_id;
  if (typeof id !== 'number') throw new Error('review insert did not return an id');
  return id;
}

/**
 * Update a review (author only). Returns false when the review doesn't
 * exist or isn't owned by userId.
 */
export async function updateReview(
  db: D1Database,
  userId: number,
  id: number,
  title: string | null,
  body: string,
  hasSpoilers: boolean,
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE reviews
          SET title = ?1, body = ?2, has_spoilers = ?3, updated_at = datetime('now')
        WHERE id = ?4 AND user_id = ?5`,
    )
    .bind(title, body, hasSpoilers ? 1 : 0, id, userId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/**
 * Delete a review (author only). Returns false when the review doesn't
 * exist or isn't owned by userId.
 */
export async function deleteReview(
  db: D1Database,
  userId: number,
  id: number,
): Promise<boolean> {
  const res = await db
    .prepare('DELETE FROM reviews WHERE id = ?1 AND user_id = ?2')
    .bind(id, userId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

// --- review rate limiting (20/hour/user) ------------------------------------

export const MAX_REVIEWS_PER_HOUR = 20;

/**
 * Returns true when the user may submit another review this hour, and
 * records the attempt. Mirrors checkMagicLinkRate (src/auth/routes.ts):
 * keyed on (user_id, UTC hour).
 */
export async function checkReviewsRate(db: D1Database, userId: number): Promise<boolean> {
  const hour = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH (UTC)
  const row = await db
    .prepare('SELECT count FROM reviews_rate WHERE user_id = ?1 AND hour = ?2')
    .bind(userId, hour)
    .first<{ count: number }>();
  if ((row?.count ?? 0) >= MAX_REVIEWS_PER_HOUR) return false;
  await db
    .prepare(
      `INSERT INTO reviews_rate (user_id, hour, count) VALUES (?1, ?2, 1)
       ON CONFLICT(user_id, hour) DO UPDATE SET count = reviews_rate.count + 1`,
    )
    .bind(userId, hour)
    .run();
  return true;
}
