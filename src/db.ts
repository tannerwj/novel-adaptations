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
  /** SEO permalink slug (migration 0020). Null until the backfill runs. */
  slug: string | null;
  /** Open Library synopsis (migration 0025). Null until the backfill runs. */
  description: string | null;
  /** JSON array of Open Library subject strings (migration 0025). */
  subjects: string | null;
}

export interface ScreenWork {
  id: number;
  tmdb_id: number | null;
  title: string;
  kind: 'film' | 'series';
  poster_url: string | null;
  /** Added in migration 0006 (TMDB enrichment backfill). */
  backdrop_url: string | null;
  release_date: string | null;
  /** Added in migration 0009; populated by future TMDB enrichment. */
  synopsis: string | null;
  /** Added in migration 0009; stored, NOT rendered yet (affiliate UI is future). */
  purchase_url_screen: string | null;
  /** SEO permalink slug (migration 0020). Null until the backfill runs. */
  slug: string | null;
  /**
   * Cached TMDB trailer lookup (migration 0025): NULL = unchecked,
   * '' = TMDB has no trailer, otherwise the YouTube video key.
   */
  trailer_youtube_key: string | null;
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
  /** Populated from screen_works.poster_url when TMDB enrichment has run. */
  screen_poster_url: string | null;
  /** Populated from screen_works.backdrop_url (migration 0006). */
  screen_backdrop_url: string | null;
  /** SEO permalink slugs (migration 0020). Null until the backfill runs. */
  adaptation_slug: string | null;
  book_slug: string | null;
  screen_slug: string | null;
}

/** Shared JOIN behind listAdaptations / getAdaptationSummary. Exported so the
 * v1 API can batch it with sibling statements in one D1 round trip. */
export const SELECT_ADAPTATION_SUMMARY = `
  SELECT a.id, a.book_id, a.screen_work_id, a.status, a.source_url,
         a.slug AS adaptation_slug,
         b.title AS book_title, b.authors AS book_authors,
         b.cover_url AS book_cover_url, b.slug AS book_slug,
         s.title AS screen_title, s.kind AS screen_kind,
         s.release_date AS screen_release_date,
         s.poster_url AS screen_poster_url,
         s.backdrop_url AS screen_backdrop_url,
         s.slug AS screen_slug
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

// --- Screen works (/watch/:id) ------------------------------------------------

/** A screen work plus its linked adaptations and linked books (one page load). */
export interface ScreenWorkDetail extends ScreenWork {
  adaptations: { id: number; title: string; status: string; slug: string | null }[];
  books: { id: number; title: string; authors: string; slug: string | null }[];
}

/** Null when no screen_works row has that id (route turns it into a 404). */
export async function getScreenWork(
  db: D1Database,
  id: number,
): Promise<ScreenWorkDetail | null> {
  const row = await db
    .prepare('SELECT * FROM screen_works WHERE id = ?1')
    .bind(id)
    .first<ScreenWork>();
  if (!row) return null;
  const { results: adaptations } = await db
    .prepare(
      `SELECT a.id, a.slug, b.title AS title, a.status
       FROM adaptations a
       JOIN books b ON b.id = a.book_id
       WHERE a.screen_work_id = ?1
       ORDER BY a.id ASC`,
    )
    .bind(id)
    .all<{ id: number; title: string; status: string; slug: string | null }>();
  const { results: books } = await db
    .prepare(
      `SELECT DISTINCT b.id, b.slug, b.title, b.authors
       FROM adaptations a
       JOIN books b ON b.id = a.book_id
       WHERE a.screen_work_id = ?1
       ORDER BY b.id ASC`,
    )
    .bind(id)
    .all<{ id: number; title: string; authors: string; slug: string | null }>();
  return { ...row, adaptations: adaptations ?? [], books: books ?? [] };
}

/** Numeric id for a slug, or null. Table is a fixed union — no injection. */
export async function idForSlug(
  db: D1Database,
  table: 'books' | 'screen_works' | 'adaptations',
  slug: string,
): Promise<number | null> {
  const row = await db
    .prepare(`SELECT id FROM ${table} WHERE slug = ?1`)
    .bind(slug)
    .first<{ id: number }>();
  return row?.id ?? null;
}

/** Slug for a numeric id, or null when the row is missing / not backfilled. */
export async function slugForId(
  db: D1Database,
  table: 'books' | 'screen_works' | 'adaptations',
  id: number,
): Promise<string | null> {
  const row = await db
    .prepare(`SELECT slug FROM ${table} WHERE id = ?1`)
    .bind(id)
    .first<{ slug: string | null }>();
  return row?.slug ?? null;
}

export async function getBookBySlug(db: D1Database, slug: string): Promise<Book | null> {
  const id = await idForSlug(db, 'books', slug);
  return id === null ? null : getBook(db, id);
}

export async function getScreenWorkBySlug(
  db: D1Database,
  slug: string,
): Promise<ScreenWorkDetail | null> {
  const id = await idForSlug(db, 'screen_works', slug);
  return id === null ? null : getScreenWork(db, id);
}

export async function getAdaptationSummaryBySlug(
  db: D1Database,
  slug: string,
): Promise<AdaptationSummary | null> {
  const row = await db
    .prepare(`${SELECT_ADAPTATION_SUMMARY} WHERE a.slug = ?1`)
    .bind(slug)
    .first<AdaptationSummary>();
  return row ?? null;
}

/**
 * News related to a screen work: items whose book_title matches (case-insensitively)
 * any linked book's title, newest first. Only approved items are visible —
 * pending stories stay behind the admin curation gate.
 */
export async function getScreenWorkNews(
  db: D1Database,
  bookTitles: string[],
): Promise<NewsItem[]> {
  const titles = bookTitles.map((t) => t.toLowerCase());
  if (titles.length === 0) return [];
  const placeholders = titles.map((_, i) => `?${i + 1}`).join(', ');
  const { results } = await db
    .prepare(
      `SELECT * FROM news_items
       WHERE book_title IS NOT NULL
         AND LOWER(book_title) IN (${placeholders})
         AND status = 'approved'
       ORDER BY published_at DESC NULLS LAST, id DESC`,
    )
    .bind(...titles)
    .all<NewsItem>();
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
 * Invariant: an adaptation may only be 'released' when its screen work has a
 * release_date on or before today. Dependency-free so unit tests can import it
 * directly (same pattern as src/news/gate.ts).
 *
 * Guards the Dune Part Three class of error: the catalog expansion seeded the
 * row as 'released' with a future release_date (2026-12-15) and nothing checked.
 * The DB triggers in migration 0021 enforce the same rule as a backstop; this
 * throws a clear error before the write so callers get a usable message.
 */
export function assertReleasedStatusAllowed(releaseDate: string | null | undefined): void {
  if (releaseDate == null || releaseDate === '') {
    throw new Error("Cannot mark 'released': screen work has no release_date");
  }
  const today = new Date().toISOString().slice(0, 10);
  // Lexicographic compare works for 'YYYY-MM-DD' and year-only 'YYYY' dates.
  if (releaseDate > today) {
    throw new Error(
      `Cannot mark 'released': release_date ${releaseDate} is in the future`,
    );
  }
}

/**
 * Ids of adaptations linked to a screen work whose 'released' status would
 * be violated by setting the work's release_date to the given value.
 * A cleared or future date invalidates every linked 'released' adaptation.
 * Callers (e.g. the admin release-date endpoint) should reject the edit so
 * the admin changes those adaptations' statuses first; migration 0022's
 * trigger is the backstop for direct SQL writes.
 */
export async function releasedAdaptationsViolatedByDate(
  db: D1Database,
  screenWorkId: number,
  releaseDate: string | null,
): Promise<number[]> {
  const today = new Date().toISOString().slice(0, 10);
  if (releaseDate != null && releaseDate !== '' && releaseDate <= today) return [];
  const { results } = await db
    .prepare('SELECT id FROM adaptations WHERE screen_work_id = ?1 AND status = \'released\'')
    .bind(screenWorkId)
    .all<{ id: number }>();
  return (results ?? []).map((r) => r.id);
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
    .prepare('SELECT status, screen_work_id FROM adaptations WHERE id = ?1')
    .bind(adaptationId)
    .first<{ status: string; screen_work_id: number }>();
  if (!adaptation) throw new Error('adaptation not found');
  const oldStatus = adaptation.status;

  if (newStatus === 'released') {
    const work = await db
      .prepare('SELECT release_date FROM screen_works WHERE id = ?1')
      .bind(adaptation.screen_work_id)
      .first<{ release_date: string | null }>();
    assertReleasedStatusAllowed(work?.release_date);
  }

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
