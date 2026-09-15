// src/ratings/db.ts — Track 1 SQL: star ratings (1–5) on books and screen
// works, plus the ratings rate limiter. Ratings are SEPARATE from votes:
// votes feed the Most Wanted leaderboard, ratings are a per-title crowd score.

export type RatingTargetType = 'book' | 'screen_work';

export const RATING_TARGET_TYPES: RatingTargetType[] = ['book', 'screen_work'];

/** Average (1 decimal) + count for a target. Average is 0 when no ratings. */
export interface RatingSummary {
  average: number;
  count: number;
}

export async function getRatingSummary(
  db: D1Database,
  targetType: RatingTargetType,
  targetId: number,
): Promise<RatingSummary> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count, AVG(rating) AS average
         FROM ratings
        WHERE target_type = ?1 AND target_id = ?2`,
    )
    .bind(targetType, targetId)
    .first<{ count: number; average: number | null }>();
  const count = row?.count ?? 0;
  // Round to one decimal; zero when there are no ratings.
  const average = count === 0 ? 0 : Math.round((row?.average ?? 0) * 10) / 10;
  return { average, count };
}

/** The rating a user gave a target, or null when they haven't rated it. */
export async function getUserRating(
  db: D1Database,
  userId: number,
  targetType: RatingTargetType,
  targetId: number,
): Promise<number | null> {
  const row = await db
    .prepare(
      `SELECT rating FROM ratings
        WHERE user_id = ?1 AND target_type = ?2 AND target_id = ?3`,
    )
    .bind(userId, targetType, targetId)
    .first<{ rating: number }>();
  return row?.rating ?? null;
}

/**
 * Upsert a user's rating, touching updated_at on re-rate.
 * Callers validate the rating range (1–5) before calling.
 */
export async function setRating(
  db: D1Database,
  userId: number,
  targetType: RatingTargetType,
  targetId: number,
  rating: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO ratings (user_id, target_type, target_id, rating)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(user_id, target_type, target_id)
       DO UPDATE SET rating = excluded.rating, updated_at = datetime('now')`,
    )
    .bind(userId, targetType, targetId, rating)
    .run();
}

// --- ratings rate limiting (60/hour/user) ------------------------------------

export const MAX_RATINGS_PER_HOUR = 60;

/**
 * Returns true when the user may write another rating this hour, and records
 * it. Keyed on (user_id, UTC hour bucket) — same pattern as magic_link_rate.
 */
export async function checkRatingsRate(db: D1Database, userId: number): Promise<boolean> {
  const hour = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH (UTC)
  const row = await db
    .prepare('SELECT count FROM ratings_rate WHERE user_id = ?1 AND hour = ?2')
    .bind(userId, hour)
    .first<{ count: number }>();
  if ((row?.count ?? 0) >= MAX_RATINGS_PER_HOUR) return false;
  await db
    .prepare(
      `INSERT INTO ratings_rate (user_id, hour, count) VALUES (?1, ?2, 1)
       ON CONFLICT(user_id, hour) DO UPDATE SET count = ratings_rate.count + 1`,
    )
    .bind(userId, hour)
    .run();
  return true;
}
