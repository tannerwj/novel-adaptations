// src/polls/db.ts — Track 3 SQL: book-vs-screen polls.
//
// No `polls` table — a poll implicitly exists for every adaptation, keyed on
// adaptation_id in poll_votes. One vote per (user, adaptation); changeable.

export type PollChoice = 'book' | 'screen' | 'both' | 'undecided';

export const POLL_CHOICES: PollChoice[] = ['book', 'screen', 'both', 'undecided'];

export interface PollResults {
  counts: Record<PollChoice, number>;
  total: number;
}

/** Live results for an adaptation: per-choice counts + total votes. */
export async function getPollResults(
  db: D1Database,
  adaptationId: number,
): Promise<PollResults> {
  const { results } = await db
    .prepare(
      `SELECT choice, COUNT(*) AS n
         FROM poll_votes
        WHERE adaptation_id = ?1
        GROUP BY choice`,
    )
    .bind(adaptationId)
    .all<{ choice: PollChoice; n: number }>();
  const counts: Record<PollChoice, number> = { book: 0, screen: 0, both: 0, undecided: 0 };
  let total = 0;
  for (const r of results ?? []) {
    counts[r.choice] = r.n;
    total += r.n;
  }
  return { counts, total };
}

/** The user's current choice for this poll, or null if they haven't voted. */
export async function getUserChoice(
  db: D1Database,
  userId: number,
  adaptationId: number,
): Promise<PollChoice | null> {
  const row = await db
    .prepare(
      'SELECT choice FROM poll_votes WHERE user_id = ?1 AND adaptation_id = ?2',
    )
    .bind(userId, adaptationId)
    .first<{ choice: PollChoice }>();
  return row?.choice ?? null;
}

/** Cast or change a vote (upsert). Returns the fresh results. */
export async function setPollVote(
  db: D1Database,
  userId: number,
  adaptationId: number,
  choice: PollChoice,
): Promise<PollResults> {
  await db
    .prepare(
      `INSERT INTO poll_votes (user_id, adaptation_id, choice)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(user_id, adaptation_id) DO UPDATE SET choice = excluded.choice`,
    )
    .bind(userId, adaptationId, choice)
    .run();
  return getPollResults(db, adaptationId);
}

// --- poll rate limiting (30/hour/user) --------------------------------------

export const MAX_POLLS_PER_HOUR = 30;

/**
 * Returns true when the user may cast/change another poll vote this rolling
 * hour, and records it. Uses the polls_rate table keyed on (user_id, UTC
 * hour) — same pattern as checkMagicLinkRate / checkFeedbackRate.
 */
export async function checkPollsRate(db: D1Database, userId: number): Promise<boolean> {
  const hour = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH (UTC)
  const row = await db
    .prepare('SELECT count FROM polls_rate WHERE user_id = ?1 AND hour = ?2')
    .bind(userId, hour)
    .first<{ count: number }>();
  if ((row?.count ?? 0) >= MAX_POLLS_PER_HOUR) return false;
  await db
    .prepare(
      `INSERT INTO polls_rate (user_id, hour, count) VALUES (?1, ?2, 1)
       ON CONFLICT(user_id, hour) DO UPDATE SET count = count + 1`,
    )
    .bind(userId, hour)
    .run();
  return true;
}
