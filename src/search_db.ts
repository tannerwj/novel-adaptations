/**
 * src/search_db.ts — site-wide search data layer (Track 3).
 *
 * Pure .ts module (no JSX) shared by the legacy page route
 * (src/search.tsx) and the v1 JSON API (src/api/v1.ts), so node unit
 * tests can import the API router without the SSR UI bundle.
 *
 * Implementation: parameterized LIKE queries (case-insensitive substring
 * match on title/authors), one query per result group, LIMIT 12 each.
 * Results are ranked in SQL by a CASE-based relevance tier — exact title
 * match, then title-prefix, then word-start, then substring, with exact and
 * prefix author matches ranked well too; titles starting with "The " are
 * normalized for exact/prefix comparisons. The WHERE clause only admits
 * genuine matches, so ranking reorders but never invents results.
 * FTS5 was deliberately NOT used — decision documented in TRACK3_NOTES.md.
 */

import { searchFilterFragments } from './search_filters';

const QUERY_MAX_LEN = 100;
export { QUERY_MAX_LEN };
export const RESULT_LIMIT = 12;
const POPULAR_LIMIT = 8;

// --- SQL (track-local; src/db.ts is owned by other tracks — DO NOT EDIT it) ---

// Relevance ranking (best-practice tiers, computed in SQL so D1 returns
// rows already ordered — one round trip per group, same as before):
//
//   rank 0 — exact title match
//   rank 1 — exact title match ignoring a leading "The "
//   rank 2 — title starts with the query
//   rank 3 — title starts with the query after a leading "The "
//   rank 4 — query starts a word inside the title ("… <q>…")
//   rank 5 — exact author match (books/adaptations)
//   rank 6 — author starts with the query
//   rank 7 — plain substring match (the WHERE clause below)
//
// Ties within a rank break alphabetically (books/works) or by recency
// (adaptation stories). The WHERE clause still only admits rows that
// actually contain the query — ranking reorders, never invents.

export interface BookHit {
  id: number;
  title: string;
  authors: string;
  slug: string | null;
  /** 0 = exact title match … 7 = substring; lower is a better match. */
  rank?: number;
}

export interface ScreenWorkHit {
  id: number;
  title: string;
  kind: 'film' | 'series';
  poster_url: string | null;
  slug: string | null;
  /** 0 = exact title match … 5 = substring; lower is a better match. */
  rank?: number;
}

export interface AdaptationHit {
  id: number;
  status: string;
  slug: string | null;
  book_title: string;
  book_authors: string;
  book_slug: string | null;
  screen_title: string;
  screen_kind: 'film' | 'series';
  screen_slug: string | null;
  /** 0 = exact title match … 7 = substring; lower is a better match. */
  rank?: number;
}

export interface PopularBook {
  id: number;
  title: string;
  authors: string;
  cover_url: string | null;
  slug: string | null;
  votes: number;
}

/** Escape LIKE wildcards in user input. */
function escapedLike(q: string): string {
  return q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Escape LIKE wildcards in user input, then wrap for a substring match. */
function likePattern(q: string): string {
  return `%${escapedLike(q)}%`;
}

/** `q%` — title/authors start with the query. */
function prefixPattern(q: string): string {
  return `${escapedLike(q)}%`;
}

/** `% q%` — the query starts a word somewhere inside the title. */
function wordPattern(q: string): string {
  return `% ${escapedLike(q)}%`;
}

export async function searchBooks(db: D1Database, q: string): Promise<BookHit[]> {
  const { results } = await searchStatements(db, q)[0].all<BookHit>();
  return results ?? [];
}

export async function searchScreenWorks(db: D1Database, q: string): Promise<ScreenWorkHit[]> {
  const { results } = await searchStatements(db, q)[1].all<ScreenWorkHit>();
  return results ?? [];
}

export async function searchAdaptations(db: D1Database, q: string): Promise<AdaptationHit[]> {
  const { results } = await searchStatements(db, q)[2].all<AdaptationHit>();
  return results ?? [];
}

/**
 * The three search-group queries as prepared statements, in [books, works,
 * adaptations] order, so callers can run them in one D1 round trip via
 * db.batch() (see src/api/v1.ts). SQL identical to the single-shot helpers
 * above — they delegate to this.
 *
 * Binds per statement: ?1 = trimmed query (exact matches), ?2 = prefix
 * pattern (`q%`), ?3 = word-start pattern (`% q%`), ?4 = substring pattern
 * (`%q%`), ?5 = limit, ?6+ = that statement's own filter values — see
 * searchFilterFragments() in ./search_filters.ts. Each statement binds
 * exactly the values its SQL references: binding a value with no matching
 * placeholder is a hard "column index out of range" error, so the three
 * statements cannot share one bind array.
 * The WHERE clause admits only genuine substring matches; the CASE rank
 * only orders them.
 *
 * Optional `filters` apply kind/status in SQL so a capped result page never
 * wastes slots on rows the client would discard.
 */
export interface SearchFilters {
  kind?: string;
  statuses?: string[];
}

export function searchStatements(
  db: D1Database,
  q: string,
  filters: SearchFilters = {},
): [D1PreparedStatement, D1PreparedStatement, D1PreparedStatement] {
  const query = q.trim().slice(0, QUERY_MAX_LEN);
  const exact = query;
  const prefix = prefixPattern(query);
  const word = wordPattern(query);
  const substr = likePattern(query);
  const { worksFilter, adaptationFilter, worksBind, adaptationBind } =
    searchFilterFragments(filters);
  return [
    db
      .prepare(
        `SELECT id, title, authors, slug,
                CASE
                  WHEN title = ?1 COLLATE NOCASE THEN 0
                  WHEN stripped = ?1 COLLATE NOCASE THEN 1
                  WHEN title LIKE ?2 ESCAPE '\\' THEN 2
                  WHEN stripped LIKE ?2 ESCAPE '\\' THEN 3
                  WHEN title LIKE ?3 ESCAPE '\\' THEN 4
                  WHEN authors = ?1 COLLATE NOCASE THEN 5
                  WHEN authors LIKE ?2 ESCAPE '\\' THEN 6
                  ELSE 7
                END AS rank
           FROM (
             SELECT id, title, authors, slug,
                    CASE WHEN title LIKE 'The %' THEN SUBSTR(title, 5) ELSE title END AS stripped
               FROM books
              WHERE title LIKE ?4 ESCAPE '\\' OR authors LIKE ?4 ESCAPE '\\'
           )
          ORDER BY rank ASC, title ASC
          LIMIT ?5`,
      )
      .bind(exact, prefix, word, substr, RESULT_LIMIT),
    db
      .prepare(
        `SELECT id, title, kind, poster_url, slug,
                CASE
                  WHEN title = ?1 COLLATE NOCASE THEN 0
                  WHEN stripped = ?1 COLLATE NOCASE THEN 1
                  WHEN title LIKE ?2 ESCAPE '\\' THEN 2
                  WHEN stripped LIKE ?2 ESCAPE '\\' THEN 3
                  WHEN title LIKE ?3 ESCAPE '\\' THEN 4
                  ELSE 5
                END AS rank
           FROM (
             SELECT id, title, kind, poster_url, slug,
                    CASE WHEN title LIKE 'The %' THEN SUBSTR(title, 5) ELSE title END AS stripped
               FROM screen_works
              WHERE title LIKE ?4 ESCAPE '\\'${worksFilter}
           )
          ORDER BY rank ASC, title ASC
          LIMIT ?5`,
      )
      .bind(exact, prefix, word, substr, RESULT_LIMIT, ...worksBind),
    db
      .prepare(
        `SELECT id, status, slug, book_title, book_authors, book_slug,
                screen_title, screen_kind, screen_slug,
                CASE
                  WHEN book_title = ?1 COLLATE NOCASE OR screen_title = ?1 COLLATE NOCASE THEN 0
                  WHEN book_stripped = ?1 COLLATE NOCASE OR screen_stripped = ?1 COLLATE NOCASE THEN 1
                  WHEN book_title LIKE ?2 ESCAPE '\\' OR screen_title LIKE ?2 ESCAPE '\\' THEN 2
                  WHEN book_stripped LIKE ?2 ESCAPE '\\' OR screen_stripped LIKE ?2 ESCAPE '\\' THEN 3
                  WHEN book_title LIKE ?3 ESCAPE '\\' OR screen_title LIKE ?3 ESCAPE '\\' THEN 4
                  WHEN book_authors = ?1 COLLATE NOCASE THEN 5
                  WHEN book_authors LIKE ?2 ESCAPE '\\' THEN 6
                  ELSE 7
                END AS rank
           FROM (
             SELECT a.id, a.status, a.slug AS slug,
                    b.title AS book_title, b.authors AS book_authors, b.slug AS book_slug,
                    s.title AS screen_title, s.kind AS screen_kind, s.slug AS screen_slug,
                    CASE WHEN b.title LIKE 'The %' THEN SUBSTR(b.title, 5) ELSE b.title END AS book_stripped,
                    CASE WHEN s.title LIKE 'The %' THEN SUBSTR(s.title, 5) ELSE s.title END AS screen_stripped
               FROM adaptations a
               JOIN books b ON b.id = a.book_id
               JOIN screen_works s ON s.id = a.screen_work_id
              WHERE (b.title LIKE ?4 ESCAPE '\\'
                 OR b.authors LIKE ?4 ESCAPE '\\'
                 OR s.title LIKE ?4 ESCAPE '\\')${adaptationFilter}
           )
          ORDER BY rank ASC, id DESC
          LIMIT ?5`,
      )
      .bind(exact, prefix, word, substr, RESULT_LIMIT, ...adaptationBind),
  ];
}

/**
 * "Popular right now" — most-voted books first (votes table), tie-broken by
 * the most recent adaptation so fresh titles surface. Degrades gracefully to
 * recency when the votes table is empty, and to an empty list when the
 * catalog itself is empty. Used for the empty-query page and as the
 * suggestions fallback when a search has no matches.
 */
export async function getPopularBooks(db: D1Database): Promise<PopularBook[]> {
  const { results } = await db
    .prepare(
      `SELECT b.id, b.title, b.authors, b.cover_url, b.slug,
              COUNT(DISTINCT v.id) AS votes
         FROM books b
         LEFT JOIN votes v ON v.book_id = b.id
         LEFT JOIN adaptations a ON a.book_id = b.id
        GROUP BY b.id
        ORDER BY votes DESC, MAX(a.id) DESC
        LIMIT ?1`,
    )
    .bind(POPULAR_LIMIT)
    .all<PopularBook>();
  return results ?? [];
}
