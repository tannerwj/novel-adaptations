// src/votes/db.ts — Track B SQL: votes, Most Wanted leaderboard, shelves,
// vote rate limiting. (src/db.ts is owned by others — DO NOT EDIT it.)

export type ShelfName = 'want_to_read' | 'read' | 'want_to_watch' | 'watched';
export type ShelfTargetType = 'book' | 'adaptation';

export const SHELVES: ShelfName[] = ['want_to_read', 'read', 'want_to_watch', 'watched'];
export const SHELF_TARGET_TYPES: ShelfTargetType[] = ['book', 'adaptation'];

/** One Most Wanted row: book identity + vote count + current user's state. */
export interface MostWantedRow {
  bookId: number;
  title: string;
  authors: string;
  coverUrl: string | null;
  slug: string | null;
  votes: number;
  userVoted: boolean;
}

export interface ShelfEntry {
  targetType: ShelfTargetType;
  targetId: number;
  title: string;
  /** SEO slug for the target (migration 0020); null until backfilled. */
  slug: string | null;
  shelf: ShelfName;
}

// --- votes ------------------------------------------------------------------

export async function hasVoted(
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

export async function countVotes(db: D1Database, bookId: number): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM votes WHERE book_id = ?1')
    .bind(bookId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Cast a vote (idempotent). Returns the new state + fresh total. */
export async function castVote(
  db: D1Database,
  userId: number,
  bookId: number,
): Promise<{ voted: boolean; votes: number }> {
  await db
    .prepare('INSERT INTO votes (user_id, book_id) VALUES (?1, ?2) ON CONFLICT(user_id, book_id) DO NOTHING')
    .bind(userId, bookId)
    .run();
  return { voted: true, votes: await countVotes(db, bookId) };
}

/** Withdraw a vote (idempotent). Returns the new state + fresh total. */
export async function withdrawVote(
  db: D1Database,
  userId: number,
  bookId: number,
): Promise<{ voted: boolean; votes: number }> {
  await db
    .prepare('DELETE FROM votes WHERE user_id = ?1 AND book_id = ?2')
    .bind(userId, bookId)
    .run();
  return { voted: false, votes: await countVotes(db, bookId) };
}

/** Toggle helper kept for convenience (POST + DELETE routes use cast/withdraw). */
export async function toggleVote(
  db: D1Database,
  userId: number,
  bookId: number,
): Promise<{ voted: boolean; votes: number }> {
  if (await hasVoted(db, userId, bookId)) return withdrawVote(db, userId, bookId);
  return castVote(db, userId, bookId);
}

/** Raw row shape of the Most Wanted leaderboard query. */
export interface MostWantedRawRow {
  bookId: number;
  title: string;
  authors: string;
  coverUrl: string | null;
  slug: string | null;
  votes: number;
  userVoted: number | null;
}

/**
 * The Most Wanted leaderboard as prepared statements — [rows, exact total] —
 * so callers can run both in one D1 round trip via db.batch().
 */
export function mostWantedStatements(
  db: D1Database,
  userId: number | null,
  limit: number,
): [D1PreparedStatement, D1PreparedStatement] {
  return [
    db
      .prepare(
        `SELECT b.id AS bookId, b.title AS title, b.authors AS authors,
                b.cover_url AS coverUrl, b.slug AS slug, COUNT(v.id) AS votes,
                MAX(CASE WHEN v.user_id = ?1 THEN 1 ELSE 0 END) AS userVoted
           FROM books b
           LEFT JOIN votes v ON v.book_id = b.id
          GROUP BY b.id
         HAVING votes > 0
          ORDER BY votes DESC, b.title ASC
          LIMIT ?2`,
      )
      .bind(userId, limit),
    db.prepare('SELECT COUNT(DISTINCT book_id) AS n FROM votes'),
  ];
}

/** Project raw leaderboard rows into MostWantedRow (shared by batch callers). */
export function mostWantedFromRows(results: MostWantedRawRow[]): MostWantedRow[] {
  return results.map((r) => ({
    bookId: r.bookId,
    title: r.title,
    authors: r.authors,
    coverUrl: r.coverUrl,
    slug: r.slug,
    votes: r.votes,
    userVoted: r.userVoted === 1,
  }));
}

/** Books ranked by vote count, DESC (Listopia-style Most Wanted). */
export async function getMostWanted(
  db: D1Database,
  userId: number | null,
  limit = 100,
): Promise<MostWantedRow[]> {
  const { results } = await mostWantedStatements(db, userId, limit)[0].all<MostWantedRawRow>();
  return mostWantedFromRows(results ?? []);
}

// --- vote rate limiting (20/day) --------------------------------------------

export const MAX_VOTES_PER_DAY = 20;

/**
 * Returns true when the user may cast another vote today, and records it.
 * Uses the vote_rate table keyed on (user_id, UTC day).
 */
export async function checkVoteRate(db: D1Database, userId: number): Promise<boolean> {
  const row = await db
    .prepare(`SELECT count FROM vote_rate WHERE user_id = ?1 AND day = date('now')`)
    .bind(userId)
    .first<{ count: number }>();
  if ((row?.count ?? 0) >= MAX_VOTES_PER_DAY) return false;
  await db
    .prepare(
      `INSERT INTO vote_rate (user_id, day, count) VALUES (?1, date('now'), 1)
       ON CONFLICT(user_id, day) DO UPDATE SET count = vote_rate.count + 1`,
    )
    .bind(userId)
    .run();
  return true;
}

// --- shelves ----------------------------------------------------------------

export async function upsertShelf(
  db: D1Database,
  userId: number,
  targetType: ShelfTargetType,
  targetId: number,
  shelf: ShelfName,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO shelf_items (user_id, target_type, target_id, shelf)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(user_id, target_type, target_id) DO UPDATE SET shelf = excluded.shelf`,
    )
    .bind(userId, targetType, targetId, shelf)
    .run();
}

export async function removeShelf(
  db: D1Database,
  userId: number,
  targetType: ShelfTargetType,
  targetId: number,
): Promise<void> {
  await db
    .prepare('DELETE FROM shelf_items WHERE user_id = ?1 AND target_type = ?2 AND target_id = ?3')
    .bind(userId, targetType, targetId)
    .run();
}

/** The shelf lookup as a prepared statement, for db.batch() callers. */
export function shelfStatement(
  db: D1Database,
  userId: number,
  targetType: ShelfTargetType,
  targetId: number,
): D1PreparedStatement {
  return db
    .prepare(
      'SELECT shelf FROM shelf_items WHERE user_id = ?1 AND target_type = ?2 AND target_id = ?3',
    )
    .bind(userId, targetType, targetId);
}

/** The shelf a user has a single target on, or null. */
export async function getShelf(
  db: D1Database,
  userId: number,
  targetType: ShelfTargetType,
  targetId: number,
): Promise<ShelfName | null> {
  const row = await shelfStatement(db, userId, targetType, targetId).first<{
    shelf: ShelfName;
  }>();
  return row?.shelf ?? null;
}

async function resolveShelfTarget(
  db: D1Database,
  targetType: ShelfTargetType,
  targetId: number,
): Promise<{ title: string; slug: string | null } | null> {
  if (targetType === 'book') {
    const row = await db
      .prepare('SELECT title, slug FROM books WHERE id = ?1')
      .bind(targetId)
      .first<{ title: string; slug: string | null }>();
    return row ? { title: row.title, slug: row.slug } : null;
  }
  // Adaptation: "Book title → Screen title".
  const row = await db
    .prepare(
      `SELECT a.slug, b.title AS book_title, s.title AS screen_title
         FROM adaptations a
         JOIN books b ON b.id = a.book_id
         JOIN screen_works s ON s.id = a.screen_work_id
        WHERE a.id = ?1`,
    )
    .bind(targetId)
    .first<{ slug: string | null; book_title: string; screen_title: string }>();
  return row ? { title: `${row.book_title} → ${row.screen_title}`, slug: row.slug } : null;
}

/** The user's shelf entries with human-readable titles, newest first. */
export async function listShelves(db: D1Database, userId: number): Promise<ShelfEntry[]> {
  const { results } = await db
    .prepare(
      `SELECT target_type AS targetType, target_id AS targetId, shelf
         FROM shelf_items
        WHERE user_id = ?1
        ORDER BY created_at DESC, id DESC`,
    )
    .bind(userId)
    .all<{ targetType: ShelfTargetType; targetId: number; shelf: ShelfName }>();

  const entries: ShelfEntry[] = [];
  for (const r of results ?? []) {
    const target = await resolveShelfTarget(db, r.targetType, r.targetId);
    if (target === null) continue; // target was deleted — skip stale rows
    entries.push({
      targetType: r.targetType,
      targetId: r.targetId,
      title: target.title,
      slug: target.slug,
      shelf: r.shelf,
    });
  }
  return entries;
}
