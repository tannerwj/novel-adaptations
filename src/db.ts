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
