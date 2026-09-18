/**
 * src/expansion.ts — Wikipedia-driven catalog expansion.
 *
 * Wikipedia's "fiction works made into feature films" lists carry one row per
 * (book, film) pair: book title, book year, author → film title, film year.
 * This module scrapes those lists into a candidates table, then drains the
 * queue on a schedule:
 *
 * - Book side: Open Library title search with the hardened author-evidence
 *   rule (same as scripts/backfill-book-details.py) — ambiguous hits are
 *   skipped, never guessed.
 * - Film side: the existing TMDB exact-title search (same as intake), plus a
 *   release-year check against the list's film year (±1).
 *
 * A candidate becomes catalog records only when BOTH sides match; the shared
 * writeIntakeRecords() writer reuses existing rows, so re-runs and
 * multi-film books can never duplicate anything. Every outcome lands in the
 * candidates table with a reason — the run is idempotent and auditable.
 */

import {
  enrichScreenWork,
  type TmdbFetcher,
} from './tmdb';
import {
  fetchOpenLibraryWorkDetails,
  writeIntakeRecords,
  type OpenLibraryBook,
} from './intake';

export interface WikiListPage {
  /** Wikipedia page title, e.g. 'List of fiction works made into feature films (D–J)'. */
  name: string;
  /** Short key stored on candidates for provenance. */
  key: string;
}

/**
 * The five novel lists. The short-fiction list is deliberately excluded: the
 * catalog tracks books, and a short story is not a book.
 */
export const WIKI_LIST_PAGES: WikiListPage[] = [
  { name: 'List of fiction works made into feature films (0–9, A–C)', key: 'novels-0-9-a-c' },
  { name: 'List of fiction works made into feature films (D–J)', key: 'novels-d-j' },
  { name: 'List of fiction works made into feature films (K–R)', key: 'novels-k-r' },
  { name: 'List of fiction works made into feature films (S–Z)', key: 'novels-s-z' },
  { name: "List of children's books made into feature films", key: 'childrens' },
];

export const WIKI_USER_AGENT = 'NovelAdaptations/1.0 (https://noveladaptations.com; catalog expansion)';

export interface WikiCandidate {
  bookTitle: string;
  bookYear: number | null;
  authors: string;
  filmTitle: string;
  filmYear: number | null;
  sourceList: string;
  sourceUrl: string;
}

export function wikiPageUrl(name: string): string {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(name.replace(/ /g, '_'))}`;
}

/* ------------------------------------------------------------------ */
/* HTML table parsing                                                  */
/* ------------------------------------------------------------------ */

/** Strip tags, decode entities, collapse whitespace. */
export function cellText(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Remove parenthetical groups that carry no 4-digit year: alt-language titles. */
function stripNonYearParens(title: string): string {
  return title
    .replace(/\([^()]*\)/g, (m) => (/\d{4}/.test(m) ? m : ''))
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Pick the book year out of a parenthetical: prefer an explicit "published" year. */
function extractBookYear(yearPart: string): number | null {
  const published = /published[^\d]*(\d{4})/i.exec(yearPart)?.[1];
  if (published) return Number(published);
  const years = yearPart.match(/\d{4}/g);
  return years ? Number(years[years.length - 1]) : null;
}

export interface ParsedBookCell {
  title: string;
  year: number | null;
  authors: string;
}

/**
 * Parse `The 25th Hour (2001), David Benioff` or
 * `She: A History of Adventure (serialised 1886–87, published as a book, 1887), H. Rider Haggard`.
 * Returns null when the cell has no usable title+author.
 */
export function parseBookCell(text: string): ParsedBookCell | null {
  // Greedy title up to the last "(...year...) , authors" group, so
  // interposed alt-language parens stay inside the title for now.
  const m = /^(.*)\(([^()]*\d{4}[^()]*)\)\s*,\s*(.+?)\s*$/.exec(text);
  if (!m) return null;
  const title = stripNonYearParens((m[1] ?? '').trim());
  let authors = (m[3] ?? '').trim();
  if (!title || !authors) return null;
  // "Madeline Wickham (as Sophie Kinsella)" — keep both names as evidence.
  const alias = /\(as\s+([^)]+)\)/i.exec(authors);
  if (alias) {
    authors = `${authors.replace(alias[0], '').trim()} & ${(alias[1] ?? '').trim()}`;
  }
  return { title, year: extractBookYear(m[2] ?? ''), authors: authors.replace(/\s{2,}/g, ' ') };
}

export interface ParsedFilmCell {
  title: string;
  year: number | null;
}

/** Parse `25th Hour (2002)` / `Camille (1936)` / `Don Quixote (1955–1969)`. */
export function parseFilmCell(text: string): ParsedFilmCell | null {
  if (!text) return null;
  const m = /^(.*?)\s*\((\d{4})[^)]*\)\s*$/.exec(text);
  if (m) return { title: stripNonYearParens((m[1] ?? '').trim()), year: Number(m[2] ?? 0) || null };
  // No year — keep the title; the processor will skip it (year is required).
  const title = stripNonYearParens(text);
  return title ? { title, year: null } : null;
}

/**
 * Parse wikitable HTML from the list pages into candidates. Rows whose film
 * cell is empty continue the previous row's book (one book, many films).
 * Unparseable rows are dropped — counted, never guessed.
 */
export function parseWikiLists(
  pages: Array<{ sourceList: string; sourceUrl: string; html: string }>,
): { candidates: WikiCandidate[]; dropped: number } {
  const candidates: WikiCandidate[] = [];
  let dropped = 0;
  for (const page of pages) {
    const tables = page.html.match(
      /<table[^>]*class="[^"]*wikitable[^"]*"[^>]*>([\s\S]*?)<\/table>/gi,
    ) ?? [];
    for (const table of tables) {
      const rows = table.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) ?? [];
      let currentBook: ParsedBookCell | null = null;
      for (const row of rows) {
        if (/<th/i.test(row)) continue; // header row
        const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) =>
          cellText(c[1] ?? ''),
        );
        if (cells.length < 2) continue;
        const bookText = cells[0] ?? '';
        const filmText = cells[1] ?? '';
        if (bookText) {
          currentBook = parseBookCell(bookText);
          if (!currentBook) {
            dropped++;
            continue;
          }
        }
        if (!currentBook) {
          dropped++; // unattributable film row (e.g. a section with no book cell)
          continue;
        }
        const film = parseFilmCell(filmText);
        if (!film) {
          dropped++;
          continue;
        }
        candidates.push({
          bookTitle: currentBook.title,
          bookYear: currentBook.year,
          authors: currentBook.authors,
          filmTitle: film.title,
          filmYear: film.year,
          sourceList: page.sourceList,
          sourceUrl: page.sourceUrl,
        });
      }
    }
  }
  return { candidates, dropped };
}

/* ------------------------------------------------------------------ */
/* Author evidence — TS port of scripts/backfill-book-details.py        */
/* ------------------------------------------------------------------ */

/** Lowercased alphanumeric tokens: 'Herbert, Frank' -> ['herbert', 'frank']. */
export function authorTokens(name: string): string[] {
  return (name.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

/** Split 'A & B', 'A and B', 'A, B' into names. */
export function splitAuthors(authors: string): string[] {
  return (authors ?? '')
    .split(/\s*(?:,|;|&|\band\b)\s*/i)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * True when one of our authors token-matches an OL author name — either
 * token set may be a subset of the other ('Herbert, Frank' vs 'Frank
 * Herbert'). Combined with the exact-title rule, a shared surname is strong
 * evidence; a bare surname alone still matches (accepted residual risk,
 * collisions are logged in the candidates table via the OL work key).
 */
export function authorMatches(ourAuthors: string, olAuthorNames: string[]): boolean {
  const ours = splitAuthors(ourAuthors).map((a) => new Set(authorTokens(a)));
  const theirs = (olAuthorNames ?? []).map((n) => new Set(authorTokens(n)));
  for (const o of ours) {
    if (o.size === 0) continue;
    for (const t of theirs) {
      if (t.size === 0) continue;
      const oInT = [...o].every((tok) => t.has(tok));
      const tInO = [...t].every((tok) => o.has(tok));
      if (oInT || tInO) return true;
    }
  }
  return false;
}

/** Lowercase, strip punctuation/whitespace — same rule as src/intake.ts. */
function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

interface OlSearchDoc {
  key?: string;
  title?: string;
  author_name?: string[];
  cover_i?: number;
  first_publish_year?: number;
}

/** GET JSON with a deadline; never throws. */
async function fetchJsonQuiet(
  url: string,
  fetcher: TmdbFetcher,
  ms: number,
  headers?: Record<string, string>,
): Promise<{ status: number; json: unknown }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetcher(url, { signal: controller.signal, headers });
    if (!res.ok) return { status: res.status, json: null };
    return { status: res.status, json: await res.json().catch(() => null) };
  } catch {
    return { status: 0, json: null };
  } finally {
    clearTimeout(timeout);
  }
}

/* ------------------------------------------------------------------ */
/* Stage 1: scrape the lists into the candidates table                 */
/* ------------------------------------------------------------------ */

export interface ScrapeResult {
  pages: number;
  candidates: number;
  /** Rows already present (or added by an earlier scrape) — not re-added. */
  alreadyKnown: number;
  dropped: number;
}

async function fetchWikiPageHtml(
  page: WikiListPage,
  fetcher: TmdbFetcher,
): Promise<string | null> {
  const url =
    'https://en.wikipedia.org/w/api.php?action=parse' +
    `&page=${encodeURIComponent(page.name)}&prop=text&format=json&formatversion=2`;
  const { status, json } = await fetchJsonQuiet(url, fetcher, 30_000, {
    'User-Agent': WIKI_USER_AGENT,
  });
  const html = (json as { parse?: { text?: string } } | null)?.parse?.text;
  return status === 200 && typeof html === 'string' ? html : null;
}

export async function scrapeAndStoreExpansionCandidates(
  db: D1Database,
  fetcher: TmdbFetcher = fetch,
): Promise<ScrapeResult> {
  const pages: Array<{ sourceList: string; sourceUrl: string; html: string }> = [];
  for (const page of WIKI_LIST_PAGES) {
    const html = await fetchWikiPageHtml(page, fetcher);
    if (html) pages.push({ sourceList: page.key, sourceUrl: wikiPageUrl(page.name), html });
  }
  const { candidates, dropped } = parseWikiLists(pages);
  let alreadyKnown = 0;
  // INSERT OR IGNORE on the (book, film, year) unique index makes re-scrapes safe.
  const stmts = candidates.map((c) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO wiki_expansion_candidates
           (book_title, book_year, authors, film_title, film_year, source_list)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
      .bind(c.bookTitle, c.bookYear, c.authors, c.filmTitle, c.filmYear, c.sourceList),
  );
  // D1 batch has a practical size limit; chunk it.
  for (let i = 0; i < stmts.length; i += 500) {
    const results = await db.batch(stmts.slice(i, i + 500));
    for (const r of results) {
      if (Number(r.meta.changes) === 0) alreadyKnown++;
    }
  }
  await db
    .prepare('INSERT INTO wiki_expansion_runs (candidates_added) VALUES (?1)')
    .bind(candidates.length - alreadyKnown)
    .run();
  return {
    pages: pages.length,
    candidates: candidates.length,
    alreadyKnown,
    dropped,
  };
}

/* ------------------------------------------------------------------ */
/* Stage 2: drain the queue                                            */
/* ------------------------------------------------------------------ */

export interface ExpansionCandidateRow {
  id: number;
  book_title: string;
  book_year: number | null;
  authors: string;
  film_title: string;
  film_year: number | null;
  source_list: string;
  attempts: number;
}

export interface ExpansionDeps {
  DB: D1Database;
  TMDB_API_KEY: string | undefined;
}

/** Milliseconds between candidates — TMDB + Open Library politeness. */
const EXPANSION_THROTTLE_MS = 300;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Resolve the book side on Open Library: exact normalized-title match plus
 * author token evidence. Prefers the edition whose first-publish year is
 * closest to the list's book year. Returns null when nothing qualifies —
 * never a guess.
 */
async function resolveBookCandidate(
  bookTitle: string,
  bookYear: number | null,
  authors: string,
  fetcher: TmdbFetcher,
): Promise<OpenLibraryBook | null> {
  const wanted = normalizeTitle(bookTitle);
  if (!wanted) return null;
  const url =
    'https://openlibrary.org/search.json?limit=10&fields=key,title,author_name,cover_i,first_publish_year' +
    `&title=${encodeURIComponent(bookTitle)}`;
  const { status, json } = await fetchJsonQuiet(url, fetcher, 10_000, {
    'User-Agent': WIKI_USER_AGENT,
  });
  if (status !== 200) return null;
  const docs = (json as { docs?: OlSearchDoc[] } | null)?.docs ?? [];
  const matches = docs.filter(
    (d) =>
      d &&
      typeof d.title === 'string' &&
      normalizeTitle(d.title) === wanted &&
      Array.isArray(d.author_name) &&
      d.author_name.length > 0 &&
      authorMatches(authors, d.author_name) &&
      typeof d.key === 'string' &&
      d.key.startsWith('/works/'),
  );
  if (matches.length === 0) return null;
  matches.sort((a, b) => {
    const da =
      bookYear != null && typeof a.first_publish_year === 'number'
        ? Math.abs(a.first_publish_year - bookYear)
        : 999;
    const db2 =
      bookYear != null && typeof b.first_publish_year === 'number'
        ? Math.abs(b.first_publish_year - bookYear)
        : 999;
    return da - db2;
  });
  const doc = matches[0]!;
  const details = await fetchOpenLibraryWorkDetails(doc.key!, fetcher);
  return {
    openlibraryId: doc.key!,
    title: doc.title!,
    authors: doc.author_name!.join(', '),
    coverUrl:
      typeof doc.cover_i === 'number'
        ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`
        : null,
    pubDate:
      typeof doc.first_publish_year === 'number'
        ? String(doc.first_publish_year)
        : null,
    description: details.description,
    subjects: details.subjects,
  };
}

/** The film's release year must be within ±1 of the list's film year. */
function filmYearOk(releaseDate: string | null, filmYear: number | null): boolean {
  if (filmYear == null) return false;
  const m = /^(\d{4})/.exec(releaseDate ?? '');
  return m != null && Math.abs(Number(m[1]) - filmYear) <= 1;
}

/** Transient failures stay retryable: keep the row pending until attempts run out. */
const MAX_ATTEMPTS = 3;

async function markRetryable(
  db: D1Database,
  id: number,
  attempts: number,
  reason: string,
): Promise<'failed' | 'pending'> {
  if (attempts + 1 >= MAX_ATTEMPTS) {
    await markCandidate(db, id, 'failed', reason);
    return 'failed';
  }
  await db
    .prepare(
      `UPDATE wiki_expansion_candidates
       SET reason = ?1, attempts = attempts + 1
       WHERE id = ?2`,
    )
    .bind(reason, id)
    .run();
  return 'pending';
}

async function markCandidate(
  db: D1Database,
  id: number,
  status: 'created' | 'skipped' | 'failed',
  reason: string | null,
  olWorkKey: string | null = null,
  tmdbId: number | null = null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE wiki_expansion_candidates
       SET status = ?1, reason = ?2, ol_work_key = ?3, tmdb_id = ?4,
           attempts = attempts + 1, processed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?5`,
    )
    .bind(status, reason, olWorkKey, tmdbId, id)
    .run();
}

/**
 * Cheap pre-check before any API call: if this exact (book, film, year)
 * adaptation is already cataloged, skip without burning provider calls.
 * (The writer re-checks by OL/TMDB id, so this is only an optimization.)
 */
async function alreadyCataloged(
  db: D1Database,
  bookTitle: string,
  filmTitle: string,
  filmYear: number | null,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT a.id FROM adaptations a
       JOIN books b ON b.id = a.book_id
       JOIN screen_works s ON s.id = a.screen_work_id
       WHERE lower(b.title) = lower(?1) AND lower(s.title) = lower(?2)
         AND (?3 IS NULL OR substr(s.release_date, 1, 4) = CAST(?3 AS TEXT))
       LIMIT 1`,
    )
    .bind(bookTitle, filmTitle, filmYear, filmYear)
    .first<{ id: number }>();
  return row != null;
}

export interface ExpansionBatchResult {
  processed: number;
  created: number;
  skipped: number;
  failed: number;
  remaining: number;
}

export async function processExpansionBatch(
  deps: ExpansionDeps,
  n: number,
  fetcher: TmdbFetcher = fetch,
): Promise<ExpansionBatchResult> {
  const result: ExpansionBatchResult = {
    processed: 0,
    created: 0,
    skipped: 0,
    failed: 0,
    remaining: 0,
  };
  if (!deps.TMDB_API_KEY) return result;
  const rows = (
    await deps.DB.prepare(
      `SELECT id, book_title, book_year, authors, film_title, film_year, source_list, attempts
       FROM wiki_expansion_candidates
       WHERE status = 'pending'
       ORDER BY id ASC
       LIMIT ?1`,
    )
      .bind(n)
      .all<ExpansionCandidateRow>()
  ).results;
  for (const row of rows) {
    result.processed++;
    try {
      if (await alreadyCataloged(deps.DB, row.book_title, row.film_title, row.film_year)) {
        await markCandidate(deps.DB, row.id, 'skipped', 'already in catalog');
        result.skipped++;
        continue;
      }
      const book = await resolveBookCandidate(
        row.book_title,
        row.book_year,
        row.authors,
        fetcher,
      );
      if (!book) {
        await markCandidate(deps.DB, row.id, 'skipped', 'no OL book match (title+author)');
        result.skipped++;
        continue;
      }
      const outcome = await enrichScreenWork(
        deps.TMDB_API_KEY,
        { title: row.film_title, kind: 'film' },
        fetcher,
      );
      if (outcome.status === 'failed' || outcome.status === 'not-attempted') {
        const disposition = await markRetryable(
          deps.DB,
          row.id,
          row.attempts,
          `TMDB error: ${outcome.status}`,
        );
        if (disposition === 'failed') result.failed++;
        continue;
      }
      if (outcome.status !== 'hit') {
        await markCandidate(deps.DB, row.id, 'skipped', 'no TMDB film match');
        result.skipped++;
        continue;
      }
      if (!filmYearOk(outcome.hit.releaseDate, row.film_year)) {
        await markCandidate(deps.DB, row.id, 'skipped', 'TMDB film year mismatch');
        result.skipped++;
        continue;
      }
      const sourceUrl = wikiPageUrl(
        WIKI_LIST_PAGES.find((p) => p.key === row.source_list)?.name ?? '',
      );
      await writeIntakeRecords(deps.DB, {
        book,
        screenWork: {
          tmdbId: outcome.hit.tmdbId,
          kind: 'film',
          title: row.film_title,
          posterUrl: outcome.hit.posterUrl,
          backdropUrl: outcome.hit.backdropUrl,
          releaseDate: outcome.hit.releaseDate,
          synopsis: outcome.hit.overview,
        },
        sourceUrl,
      });
      await markCandidate(deps.DB, row.id, 'created', null, book.openlibraryId, outcome.hit.tmdbId);
      result.created++;
    } catch (e) {
      const disposition = await markRetryable(
        deps.DB,
        row.id,
        row.attempts,
        `error: ${(e as Error).message}`,
      );
      if (disposition === 'failed') result.failed++;
    }
    await sleep(EXPANSION_THROTTLE_MS);
  }
  result.remaining = await countPendingExpansion(deps.DB);
  return result;
}

export async function countPendingExpansion(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS c FROM wiki_expansion_candidates WHERE status = 'pending'`)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

export async function countTotalExpansion(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS c FROM wiki_expansion_candidates`)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

export async function expansionStats(
  db: D1Database,
): Promise<Record<string, number>> {
  const rows = (
    await db
      .prepare(
        `SELECT status, COUNT(*) AS c FROM wiki_expansion_candidates GROUP BY status`,
      )
      .all<{ status: string; c: number }>()
  ).results;
  const stats: Record<string, number> = { pending: 0, created: 0, skipped: 0, failed: 0 };
  for (const r of rows) stats[r.status] = r.c;
  return stats;
}

/** Hours since the last scrape run, or null when no run has completed. */
export async function hoursSinceLastScrape(db: D1Database): Promise<number | null> {
  const row = await db
    .prepare(
      `SELECT (strftime('%s', 'now') - strftime('%s', started_at)) / 3600.0 AS h
       FROM wiki_expansion_runs ORDER BY id DESC LIMIT 1`,
    )
    .first<{ h: number | null }>();
  return row?.h ?? null;
}
