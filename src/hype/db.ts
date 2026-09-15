// src/hype/db.ts — Track 4 SQL: hype meter for unreleased screen works.
//
// Hype is the pre-release counterpart to ratings (Track 1): a 1–5 "how hyped
// are you?" level per (user, screen work), changeable at any time.

/** Aggregate hype for one screen work. Average is 0 when nobody is hyped yet. */
export interface HypeSummary {
  average: number;
  count: number;
}

/** Average (1 decimal) + count for one screen work; { average: 0, count: 0 } when none. */
export async function getHypeSummary(
  db: D1Database,
  screenWorkId: number,
): Promise<HypeSummary> {
  const row = await db
    .prepare(
      `SELECT ROUND(AVG(level), 1) AS average, COUNT(*) AS count
         FROM hype
        WHERE screen_work_id = ?1`,
    )
    .bind(screenWorkId)
    .first<{ average: number | null; count: number }>();
  return { average: row?.average ?? 0, count: row?.count ?? 0 };
}

/**
 * Batch aggregates for many screen works in one query — for list/calendar
 * rendering where per-row queries would N+1. Returns a map keyed by
 * screen_work_id; works with no hype are absent from the map.
 */
export async function getHypeSummaries(
  db: D1Database,
  screenWorkIds: number[],
): Promise<Map<number, HypeSummary>> {
  const out = new Map<number, HypeSummary>();
  if (screenWorkIds.length === 0) return out;
  const placeholders = screenWorkIds.map((_, i) => `?${i + 1}`).join(', ');
  const { results } = await db
    .prepare(
      `SELECT screen_work_id AS screenWorkId,
              ROUND(AVG(level), 1) AS average, COUNT(*) AS count
         FROM hype
        WHERE screen_work_id IN (${placeholders})
        GROUP BY screen_work_id`,
    )
    .bind(...screenWorkIds)
    .all<{ screenWorkId: number; average: number | null; count: number }>();
  for (const r of results ?? []) {
    out.set(r.screenWorkId, { average: r.average ?? 0, count: r.count });
  }
  return out;
}

/** The viewer's own hype level for a screen work, or null. */
export async function getUserHype(
  db: D1Database,
  userId: number,
  screenWorkId: number,
): Promise<number | null> {
  const row = await db
    .prepare('SELECT level FROM hype WHERE user_id = ?1 AND screen_work_id = ?2')
    .bind(userId, screenWorkId)
    .first<{ level: number }>();
  return row?.level ?? null;
}

/** Set or change a user's hype (upsert), touching updated_at; returns the fresh summary. */
export async function setHype(
  db: D1Database,
  userId: number,
  screenWorkId: number,
  level: number,
): Promise<HypeSummary> {
  await db
    .prepare(
      `INSERT INTO hype (user_id, screen_work_id, level)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(user_id, screen_work_id)
       DO UPDATE SET level = excluded.level, updated_at = datetime('now')`,
    )
    .bind(userId, screenWorkId, level)
    .run();
  return getHypeSummary(db, screenWorkId);
}

// --- hype rate limiting (60 writes/hour/user) -------------------------------

export const MAX_HYPE_PER_HOUR = 60;

/** UTC hour bucket key matching the hype_rate table, e.g. '2026-09-15 17:00'. */
export function currentHourBucket(): string {
  return new Date().toISOString().slice(0, 13).replace('T', ' ') + ':00';
}

/**
 * Returns true when the user may write another hype this hour, and records it.
 * Uses the hype_rate table keyed on (user_id, UTC hour bucket).
 */
export async function checkHypeRate(db: D1Database, userId: number): Promise<boolean> {
  const hour = currentHourBucket();
  const row = await db
    .prepare('SELECT count FROM hype_rate WHERE user_id = ?1 AND hour = ?2')
    .bind(userId, hour)
    .first<{ count: number }>();
  if ((row?.count ?? 0) >= MAX_HYPE_PER_HOUR) return false;
  await db
    .prepare(
      `INSERT INTO hype_rate (user_id, hour, count) VALUES (?1, ?2, 1)
       ON CONFLICT(user_id, hour) DO UPDATE SET count = hype_rate.count + 1`,
    )
    .bind(userId, hour)
    .run();
  return true;
}

/**
 * True when a screen work is unreleased: release_date is NULL/empty (TBA) or
 * a future date. Compares as ISO strings, so 'YYYY-MM-DD' and
 * 'YYYY-MM-DDTHH:MM' both work. Only the first 10 chars of the stored value
 * are compared, against today's UTC date (matching SQLite's date('now')).
 */
export function isUnreleased(releaseDate: string | null): boolean {
  if (!releaseDate || releaseDate.trim() === '') return true;
  const day = releaseDate.trim().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  return day > today;
}
