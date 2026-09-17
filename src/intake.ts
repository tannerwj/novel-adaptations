/**
 * src/intake.ts — turn an adaptation_tip feedback item into catalog records.
 *
 * One admin click ("Fetch metadata") resolves the tip's title against real
 * metadata providers and creates the book + screen work + adaptation rows:
 *
 * - Screen work: the tip's proof URL usually carries an IMDb id (tt...),
 *   resolved via TMDB's /find endpoint — an exact identity lookup, never a
 *   title guess. Without an IMDb id it falls back to the exact-title TMDB
 *   search (film, then series).
 * - Book: Open Library title search, exact normalized-title match only.
 *
 * All writes are idempotent: existing rows are reused by tmdb_id /
 * openlibrary_id / (book_id, screen_work_id), so re-running an intake can
 * never duplicate the catalog. Nothing is written until every lookup has
 * succeeded — a failed lookup aborts with a plain-English error and the
 * database is untouched.
 */

import {
  enrichScreenWork,
  findByImdbId,
  type TmdbFetcher,
} from './tmdb';

/** Timeout for Open Library calls (no key, plain GET). */
const OPEN_LIBRARY_TIMEOUT_MS = 10_000;

export class IntakeError extends Error {}

/** GET JSON with the deadline held through body consumption. */
async function fetchJsonTimeout(
  url: string,
  fetcher: TmdbFetcher,
  ms: number,
): Promise<{ status: number; json: unknown }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetcher(url, { signal: controller.signal });
    if (!res.ok) return { status: res.status, json: null };
    return { status: res.status, json: await res.json().catch(() => null) };
  } finally {
    clearTimeout(timeout);
  }
}

/** Lowercase, strip punctuation/whitespace — same rule as the TMDB matcher. */
function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

interface OpenLibraryDoc {
  key?: string;
  title?: string;
  author_name?: string[];
  cover_i?: number;
  first_publish_year?: number;
}

export interface OpenLibraryBook {
  openlibraryId: string;
  title: string;
  authors: string;
  coverUrl: string | null;
  pubDate: string | null;
  description: string | null;
  /** JSON-encoded array of subject strings (may be '[]'). */
  subjects: string;
}

/** Work-detail payload from Open Library (description/subjects live here). */
interface OpenLibraryWork {
  description?: string | { value?: string };
  subjects?: unknown;
}

/**
 * Fetch a work's description + subjects from Open Library. Never throws —
 * returns nulls on any failure so intake still succeeds without them.
 */
export async function fetchOpenLibraryWorkDetails(
  workKey: string,
  fetcher: TmdbFetcher = fetch,
): Promise<{ description: string | null; subjects: string }> {
  const empty = { description: null, subjects: '[]' };
  if (!workKey.startsWith('/works/')) return empty;
  try {
    const { status, json } = await fetchJsonTimeout(
      `https://openlibrary.org${workKey}.json`,
      fetcher,
      OPEN_LIBRARY_TIMEOUT_MS,
    );
    if (status !== 200 || !json) return empty;
    const work = json as OpenLibraryWork;
    const rawDesc = work.description;
    const description =
      typeof rawDesc === 'string'
        ? rawDesc.trim() || null
        : typeof rawDesc?.value === 'string' && rawDesc.value.trim()
          ? rawDesc.value.trim()
          : null;
    const subjects = Array.isArray(work.subjects)
      ? work.subjects.filter((s): s is string => typeof s === 'string').slice(0, 12)
      : [];
    return { description, subjects: JSON.stringify(subjects) };
  } catch {
    return empty;
  }
}

/**
 * Find a book on Open Library by exact normalized-title match. Returns null
 * when nothing matches — never a guess.
 */
export async function findBookOnOpenLibrary(
  title: string,
  fetcher: TmdbFetcher = fetch,
): Promise<OpenLibraryBook | null> {
  const wanted = normalizeTitle(title.trim());
  if (!wanted) return null;
  const url =
    'https://openlibrary.org/search.json?limit=10&fields=key,title,author_name,cover_i,first_publish_year' +
    `&title=${encodeURIComponent(title.trim())}`;
  let payload: { docs?: OpenLibraryDoc[] } | null;
  try {
    const { status, json } = await fetchJsonTimeout(url, fetcher, OPEN_LIBRARY_TIMEOUT_MS);
    if (status !== 200) return null;
    payload = json as { docs?: OpenLibraryDoc[] } | null;
  } catch {
    return null;
  }
  const docs = Array.isArray(payload?.docs) ? payload!.docs : [];
  const doc = docs.find(
    (d) =>
      d &&
      typeof d.title === 'string' &&
      normalizeTitle(d.title) === wanted &&
      Array.isArray(d.author_name) &&
      d.author_name.length > 0 &&
      typeof d.key === 'string' &&
      d.key.startsWith('/works/'),
  );
  if (!doc) return null;
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

/* Slug helpers — TS port of scripts/backfill-slugs.py so new rows get the
 * same deterministic permalink shape as the backfilled catalog. */

function slugify(text: string): string {
  const ascii = (text || '').normalize('NFKD').replace(/[^\x00-\x7F]/g, '');
  return (
    ascii
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80)
      .replace(/-+$/, '') || 'untitled'
  );
}

function firstAuthor(authors: string): string | null {
  const first = ((authors || '').split(/\s+and\s+|[,;&]/i)[0] ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  return first || null;
}

function cap(base: string, limit = 90): string {
  return base.slice(0, limit).replace(/-+$/, '') || 'untitled';
}

function bookSlugBase(title: string, authors: string): string {
  const base = slugify(title);
  const fa = firstAuthor(authors);
  return fa ? cap(`${base}-${slugify(fa)}`) : base;
}

function workSlugBase(title: string, releaseDate: string | null): string {
  const base = slugify(title);
  const m = /^(\d{4})/.exec(releaseDate || '');
  return m ? cap(`${base}-${m[1]}`) : base;
}

/** First unused slug for the table: base, base-2, base-3, … */
async function uniqueSlug(
  db: D1Database,
  table: 'books' | 'screen_works' | 'adaptations',
  base: string,
): Promise<string> {
  let slug = base;
  for (let n = 2; ; n++) {
    const row = await db
      .prepare(`SELECT id FROM ${table} WHERE slug = ?1`)
      .bind(slug)
      .first<{ id: number }>();
    if (!row) return slug;
    slug = `${base}-${n}`;
  }
}

export interface IntakeInput {
  /** Feedback subject — the title, e.g. "The love hypothesis". */
  subject: string;
  /** Proof URL — ideally carries an IMDb id. */
  proofUrl: string | null;
  /** Source URL stored on the adaptation (the proof URL). */
  sourceUrl: string | null;
  tmdbApiKey?: string;
}

export interface IntakeResult {
  book: { id: number; title: string; created: boolean };
  screenWork: { id: number; title: string; kind: string; created: boolean };
  adaptation: { id: number; status: string; created: boolean };
  warnings: string[];
}

/** IMDb id (tt…) from a proof URL, or null. */
export function imdbIdFromUrl(url: string | null): string | null {
  if (!url) return null;
  return /imdb\.com\/title\/(tt\d+)/i.exec(url)?.[1] ?? null;
}

/**
 * Resolve a tip to catalog records. Throws IntakeError (plain English) when
 * a lookup fails; the database is only written after every lookup succeeds.
 */
export async function intakeFromTip(
  db: D1Database,
  input: IntakeInput,
  fetcher: TmdbFetcher = fetch,
): Promise<IntakeResult> {
  const title = input.subject.trim();
  if (!title) throw new IntakeError('The tip has no title to look up.');
  const apiKey = input.tmdbApiKey;
  if (!apiKey) {
    throw new IntakeError('TMDB_API_KEY is not configured — cannot fetch movie metadata.');
  }

  // 1. Resolve the screen work — exact identity first, title search fallback.
  const imdbId = imdbIdFromUrl(input.proofUrl);
  let tmdbId: number;
  let kind: 'film' | 'series';
  let workTitle: string;
  let posterUrl: string;
  let backdropUrl: string | null;
  let releaseDate: string | null;
  let synopsis: string | null;

  if (imdbId) {
    const found = await findByImdbId(apiKey, imdbId, fetcher);
    if (found.status === 'failed') {
      throw new IntakeError(`TMDB lookup failed: ${found.message ?? 'network error'} — try again.`);
    }
    if (found.status !== 'hit' || !found.title) {
      throw new IntakeError(`TMDB has no title for IMDb id ${imdbId}.`);
    }
    tmdbId = found.hit.tmdbId;
    kind = found.kind;
    workTitle = found.title;
    posterUrl = found.hit.posterUrl;
    backdropUrl = found.hit.backdropUrl;
    releaseDate = found.hit.releaseDate;
    synopsis = found.hit.overview;
  } else {
    // No IMDb id: exact-title search, film first then series. The search
    // enforces normalized-title equality, so the tip subject is the title.
    let outcome = await enrichScreenWork(apiKey, { title, kind: 'film' }, fetcher);
    let hitKind: 'film' | 'series' = 'film';
    if (outcome.status === 'no-match' || outcome.status === 'not-attempted') {
      outcome = await enrichScreenWork(apiKey, { title, kind: 'series' }, fetcher);
      hitKind = 'series';
    }
    if (outcome.status === 'failed') {
      throw new IntakeError(`TMDB lookup failed: ${outcome.message ?? 'network error'} — try again.`);
    }
    if (outcome.status !== 'hit') {
      throw new IntakeError(`No TMDB match for "${title}" — check the spelling or add a proof URL with an IMDb link.`);
    }
    tmdbId = outcome.hit.tmdbId;
    kind = hitKind;
    workTitle = title;
    posterUrl = outcome.hit.posterUrl;
    backdropUrl = outcome.hit.backdropUrl;
    releaseDate = outcome.hit.releaseDate;
    synopsis = outcome.hit.overview;
  }

  // 2. Resolve the book on Open Library — exact title match only.
  const book = await findBookOnOpenLibrary(title, fetcher);
  if (!book) {
    throw new IntakeError(
      `No book match on Open Library for "${title}" — add the book manually, then re-run.`,
    );
  }

  // 3. Write — reusing existing rows so re-runs never duplicate.
  //
  // All inserts go through ONE db.batch(), which D1 executes as a single
  // all-or-nothing transaction: a later insert can never leave partial
  // records behind. Existence was resolved above; the adaptation row links
  // via COALESCE(known id, subselect of the row this batch just inserted).
  const warnings: string[] = [];

  const existingWork = await db
    .prepare('SELECT id, title FROM screen_works WHERE tmdb_id = ?1')
    .bind(tmdbId)
    .first<{ id: number; title: string }>();
  if (existingWork) workTitle = existingWork.title;

  const existingBook = await db
    .prepare('SELECT id FROM books WHERE openlibrary_id = ?1')
    .bind(book.openlibraryId)
    .first<{ id: number }>();

  // An adaptation links exactly one book row to one screen-work row: when
  // both sides already exist, check for it; when either side is new, the
  // adaptation cannot exist yet.
  const existingAdaptation =
    existingBook && existingWork
      ? await db
          .prepare('SELECT id, status FROM adaptations WHERE book_id = ?1 AND screen_work_id = ?2')
          .bind(existingBook.id, existingWork.id)
          .first<{ id: number; status: string }>()
      : null;
  if (existingAdaptation) {
    warnings.push('This adaptation is already in the catalog — existing records were reused.');
  }

  // Slugs are resolved up front (reads) so the batch is fully formed.
  const workSlug = existingWork
    ? null
    : await uniqueSlug(db, 'screen_works', workSlugBase(workTitle, releaseDate));
  const bookSlug = existingBook
    ? null
    : await uniqueSlug(db, 'books', bookSlugBase(book.title, book.authors));
  // Release invariant: 'released' requires release_date on/before today.
  const today = new Date().toISOString().slice(0, 10);
  const adaptationStatus = existingAdaptation
    ? existingAdaptation.status
    : !releaseDate
      ? 'rumored'
      : releaseDate > today
        ? 'post_production'
        : 'released';
  const adaptSlug = existingAdaptation
    ? null
    : await uniqueSlug(db, 'adaptations', workSlugBase(workTitle, releaseDate));

  const stmts: D1PreparedStatement[] = [];
  let workIdx = -1;
  let bookIdx = -1;
  let adaptIdx = -1;
  if (!existingWork) {
    workIdx = stmts.length;
    stmts.push(
      db
        .prepare(
          `INSERT INTO screen_works
             (tmdb_id, title, kind, poster_url, backdrop_url, release_date,
              synopsis, needs_enrichment, slug)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8)`,
        )
        .bind(tmdbId, workTitle, kind, posterUrl, backdropUrl, releaseDate, synopsis, workSlug),
    );
  }
  if (!existingBook) {
    bookIdx = stmts.length;
    stmts.push(
      db
        .prepare(
          `INSERT INTO books
             (title, authors, cover_url, pub_date, openlibrary_id, slug, description, subjects)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
        )
        .bind(book.title, book.authors, book.coverUrl, book.pubDate, book.openlibraryId, bookSlug, book.description, book.subjects),
    );
  }
  if (!existingAdaptation) {
    adaptIdx = stmts.length;
    stmts.push(
      db
        .prepare(
          `INSERT INTO adaptations (book_id, screen_work_id, status, source_url, slug)
           SELECT COALESCE(?1, (SELECT id FROM books WHERE openlibrary_id = ?2)),
                  COALESCE(?3, (SELECT id FROM screen_works WHERE tmdb_id = ?4)),
                  ?5, ?6, ?7`,
        )
        .bind(
          existingBook?.id ?? null,
          book.openlibraryId,
          existingWork?.id ?? null,
          tmdbId,
          adaptationStatus,
          input.sourceUrl,
          adaptSlug,
        ),
    );
  }

  const results = stmts.length > 0 ? await db.batch(stmts) : [];

  // workIdx/bookIdx/adaptIdx are >= 0 exactly when their statement was
  // queued, so the corresponding result always exists here.
  const batchRowId = (i: number): number => Number(results[i]?.meta.last_row_id);
  const screenWorkId = existingWork ? existingWork.id : batchRowId(workIdx);
  const bookId = existingBook ? existingBook.id : batchRowId(bookIdx);
  const adaptationId = existingAdaptation ? existingAdaptation.id : batchRowId(adaptIdx);

  return {
    book: { id: bookId, title: book.title, created: !existingBook },
    screenWork: { id: screenWorkId, title: workTitle, kind, created: !existingWork },
    adaptation: { id: adaptationId, status: adaptationStatus, created: !existingAdaptation },
    warnings,
  };
}
