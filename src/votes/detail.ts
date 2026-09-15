// src/votes/detail.ts — data helpers for the detail pages.
// Timeline feeds StatusTimeline (owned by Track C); vote state feeds the
// userVoted / userShelf props on the redesigned detail pages.

export interface TimelineEvent {
  status: string;
  at: string | null;
  sourceUrl: string | null;
}

/**
 * The status history of an adaptation, oldest first, from
 * adaptation_status_audit. When there is no audit trail (e.g. legacy seed
 * rows), synthesize a single event from the adaptation's current status so
 * StatusTimeline always has something to render.
 */
export async function getAdaptationTimeline(
  db: D1Database,
  adaptationId: number,
): Promise<TimelineEvent[]> {
  const { results } = await db
    .prepare(
      `SELECT new_status AS status, created_at AS at, source_url AS sourceUrl
         FROM adaptation_status_audit
        WHERE adaptation_id = ?1
        ORDER BY created_at ASC, id ASC`,
    )
    .bind(adaptationId)
    .all<TimelineEvent>();

  if (results && results.length > 0) return results;

  const current = await db
    .prepare('SELECT status, source_url AS sourceUrl FROM adaptations WHERE id = ?1')
    .bind(adaptationId)
    .first<{ status: string; sourceUrl: string | null }>();
  if (!current) return [];
  return [{ status: current.status, at: null, sourceUrl: current.sourceUrl }];
}

/** Whether a user currently has a vote on a book. */
export async function getBookVoteState(
  db: D1Database,
  userId: number,
  bookId: number,
): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS one FROM votes WHERE user_id = ?1 AND book_id = ?2')
    .bind(userId, bookId)
    .first<{ one: number }>();
  return row !== null;
}
