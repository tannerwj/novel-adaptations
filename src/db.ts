// src/db.ts — small D1 data-access helpers. All SQL lives here.

export interface Book {
  id: number;
  title: string;
  authors: string;
  cover_url: string | null;
  pub_date: string | null;
  isbn: string | null;
  openlibrary_id: string | null;
  googlebooks_id: string | null;
}

export interface ScreenWork {
  id: number;
  tmdb_id: number | null;
  title: string;
  kind: 'film' | 'series';
  poster_url: string | null;
  release_date: string | null;
}

export interface Adaptation {
  id: number;
  book_id: number;
  screen_work_id: number;
  status:
    | 'rumored'
    | 'optioned'
    | 'in_development'
    | 'filming'
    | 'post_production'
    | 'released'
    | 'cancelled';
  source_url: string | null;
}

/** One row of the joined adaptation list used by the browse page and API. */
export interface AdaptationSummary extends Adaptation {
  book_title: string;
  book_authors: string;
  book_cover_url: string | null;
  screen_title: string;
  screen_kind: 'film' | 'series';
  screen_release_date: string | null;
}

const SELECT_ADAPTATION_SUMMARY = `
  SELECT a.id, a.book_id, a.screen_work_id, a.status, a.source_url,
         b.title AS book_title, b.authors AS book_authors,
         b.cover_url AS book_cover_url,
         s.title AS screen_title, s.kind AS screen_kind,
         s.release_date AS screen_release_date
  FROM adaptations a
  JOIN books b ON b.id = a.book_id
  JOIN screen_works s ON s.id = a.screen_work_id
`;

export async function listAdaptations(db: D1Database): Promise<AdaptationSummary[]> {
  const { results } = await db
    .prepare(`${SELECT_ADAPTATION_SUMMARY} ORDER BY a.id ASC`)
    .all<AdaptationSummary>();
  return results ?? [];
}

export async function getAdaptationSummary(
  db: D1Database,
  id: number,
): Promise<AdaptationSummary | null> {
  const row = await db
    .prepare(`${SELECT_ADAPTATION_SUMMARY} WHERE a.id = ?1`)
    .bind(id)
    .first<AdaptationSummary>();
  return row ?? null;
}

export async function getBook(db: D1Database, id: number): Promise<Book | null> {
  const row = await db.prepare('SELECT * FROM books WHERE id = ?1').bind(id).first<Book>();
  return row ?? null;
}

export async function getBookAdaptations(
  db: D1Database,
  bookId: number,
): Promise<AdaptationSummary[]> {
  const { results } = await db
    .prepare(`${SELECT_ADAPTATION_SUMMARY} WHERE a.book_id = ?1 ORDER BY a.id ASC`)
    .bind(bookId)
    .all<AdaptationSummary>();
  return results ?? [];
}

// --- News pipeline (Phase 3) ------------------------------------------------

export type NewsStatus = 'pending' | 'approved' | 'dismissed';
export type TrustTier = 'trusted' | 'reputable' | 'rumor';

export interface NewsItem {
  id: number;
  url: string;
  url_hash: string;
  title: string;
  summary: string | null;
  source: string;
  trust_tier: TrustTier;
  published_at: string | null;
  status: NewsStatus;
  is_adaptation_news: number;
  book_title: string | null;
  author: string | null;
  screen_kind: string | null;
  status_signal: string | null;
  confidence: number | null;
  llm_model: string | null;
  needs_review: number;
  dismiss_reason: string | null;
  created_at: string;
}

export interface SourceRow {
  name: string;
  feed_url: string;
  trust_tier: TrustTier;
  is_active: number;
  last_fetched_at: string | null;
  last_status: string | null;
  consecutive_failures: number;
}

const VALID_NEWS_STATUSES: NewsStatus[] = ['pending', 'approved', 'dismissed'];

/** Curation queue, ordered by trust tier then confidence (low-confidence last). */
export async function listNewsItems(db: D1Database, status: NewsStatus): Promise<NewsItem[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM news_items WHERE status = ?1
       ORDER BY CASE trust_tier WHEN 'trusted' THEN 0 WHEN 'reputable' THEN 1 ELSE 2 END,
                confidence DESC NULLS LAST, id ASC`,
    )
    .bind(status)
    .all<NewsItem>();
  return results ?? [];
}

export async function getNewsItem(db: D1Database, id: number): Promise<NewsItem | null> {
  const row = await db.prepare('SELECT * FROM news_items WHERE id = ?1').bind(id).first<NewsItem>();
  return row ?? null;
}

export async function countNewsByStatus(
  db: D1Database,
): Promise<Record<NewsStatus, number>> {
  const { results } = await db
    .prepare('SELECT status, COUNT(*) AS n FROM news_items GROUP BY status')
    .all<{ status: NewsStatus; n: number }>();
  const counts: Record<NewsStatus, number> = { pending: 0, approved: 0, dismissed: 0 };
  for (const r of results ?? []) {
    if (VALID_NEWS_STATUSES.includes(r.status)) counts[r.status] = r.n;
  }
  return counts;
}

export async function setNewsItemStatus(
  db: D1Database,
  id: number,
  status: NewsStatus,
  dismissReason?: string,
): Promise<boolean> {
  const res = await db
    .prepare('UPDATE news_items SET status = ?1, dismiss_reason = ?2 WHERE id = ?3')
    .bind(status, dismissReason ?? null, id)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function listSources(db: D1Database): Promise<SourceRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM sources ORDER BY name ASC')
    .all<SourceRow>();
  return results ?? [];
}

export const ADAPTATION_STATUSES = [
  'rumored',
  'optioned',
  'in_development',
  'filming',
  'post_production',
  'released',
  'cancelled',
] as const;

/** The default promote ladder: rumored → optioned → … → released. */
const PROMOTE_LADDER = [
  'rumored',
  'optioned',
  'in_development',
  'filming',
  'post_production',
  'released',
] as const;

export function nextStatusAfter(current: string): string | null {
  const i = (PROMOTE_LADDER as readonly string[]).indexOf(current);
  return i >= 0 && i < PROMOTE_LADDER.length - 1 ? PROMOTE_LADDER[i + 1]! : null;
}

/**
 * Promote a news item: mark it approved, advance (or set) the linked
 * adaptation's status, and write an audit row. All in one D1 batch so the
 * three writes stay consistent.
 */
export async function promoteNewsItem(
  db: D1Database,
  item: NewsItem,
  adaptationId: number,
  newStatus: string,
  sourceUrl: string,
  changedBy = 'owner',
): Promise<{ oldStatus: string; newStatus: string }> {
  const adaptation = await db
    .prepare('SELECT status FROM adaptations WHERE id = ?1')
    .bind(adaptationId)
    .first<{ status: string }>();
  if (!adaptation) throw new Error('adaptation not found');
  const oldStatus = adaptation.status;

  const batch: D1PreparedStatement[] = [
    db
      .prepare("UPDATE news_items SET status = 'approved' WHERE id = ?1")
      .bind(item.id),
    db
      .prepare('UPDATE adaptations SET status = ?1, source_url = ?2 WHERE id = ?3')
      .bind(newStatus, sourceUrl, adaptationId),
    db
      .prepare(
        `INSERT INTO adaptation_status_audit
           (adaptation_id, old_status, new_status, source_url, news_item_id, changed_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
      .bind(adaptationId, oldStatus, newStatus, sourceUrl, item.id, changedBy),
  ];
  await db.batch(batch);
  return { oldStatus, newStatus };
}
