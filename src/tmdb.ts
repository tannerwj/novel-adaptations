/**
 * src/tmdb.ts — TMDB enrichment for screen works.
 *
 * Given a screen work's title (+ release year when known), search TMDB and
 * return the poster/backdrop image URLs and TMDB id we persist on
 * screen_works (poster_url, backdrop_url, tmdb_id).
 *
 * Graceful by design: with no TMDB_API_KEY everything is a no-op returning
 * null. The network boundary is the injected `fetcher`, so the lookup logic
 * is pure and unit-testable without a real key.
 */

export interface TmdbEnv {
  /** Set via `wrangler secret put TMDB_API_KEY`. Absent → enrichment is a no-op. */
  TMDB_API_KEY?: string;
}

export interface TmdbEnrichment {
  tmdbId: number;
  /** `https://image.tmdb.org/t/p/w500…` — always set when we return a result. */
  posterUrl: string;
  /** `https://image.tmdb.org/t/p/w1280…` — may be null when TMDB has none. */
  backdropUrl: string | null;
  /**
   * TMDB `release_date` (film) / `first_air_date` (series), strictly
   * validated as `YYYY-MM-DD`. May be null when TMDB has no date —
   * applied to `screen_works.release_date` only when the row lacks one,
   * so the release calendar stops saying TBA wherever TMDB knows the date.
   */
  releaseDate: string | null;
}

export interface TmdbSearchInput {
  title: string;
  kind: 'film' | 'series';
  /** Release year, when we have one (from screen_works.release_date). */
  year?: number | null;
}

/** Network boundary for TMDB calls — inject a fake in tests. */
export type TmdbFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

const TMDB_API = 'https://api.themoviedb.org/3';
const POSTER_SIZE = 'w500';
const BACKDROP_SIZE = 'w1280';

/** Normalize for title matching: lowercase, strip punctuation/whitespace. */
function normalizeTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

interface TmdbSearchResult {
  id: number;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  poster_path: string | null;
  backdrop_path: string | null;
  release_date?: string | null;
  first_air_date?: string | null;
}

/** Strict `YYYY-MM-DD`, the only shape we persist as a release date. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** TMDB date field (may be empty/malformed) → validated date or null. */
function isoDateOrNull(raw: string | null | undefined): string | null {
  return typeof raw === 'string' && ISO_DATE.test(raw) ? raw : null;
}

/**
 * Search TMDB for a title. Uses the kind-specific endpoint — /search/movie
 * for films, /search/tv for series — rather than /search/multi, so a film
 * can never match a TV series of the same name (or a person/collection).
 * The year is passed as a search filter (year / first_air_date_year) when
 * known, which is the standard way to disambiguate remakes.
 *
 * Picks the first result carrying a poster, preferring one whose normalized
 * title matches the query; returns null when nothing suitable is found.
 */
export async function searchTmdb(
  apiKey: string,
  input: TmdbSearchInput,
  fetcher: TmdbFetcher = fetch,
): Promise<TmdbEnrichment | null> {
  const title = input.title.trim();
  if (!apiKey || !title) return null;

  const endpoint = input.kind === 'series' ? 'search/tv' : 'search/movie';
  const params = new URLSearchParams({
    api_key: apiKey,
    query: title,
    language: 'en-US',
    page: '1',
    include_adult: 'false',
  });
  if (input.year && Number.isInteger(input.year) && input.year > 1800) {
    params.set(input.kind === 'series' ? 'first_air_date_year' : 'year', String(input.year));
  }

  let res: Response;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      res = await fetcher(`${TMDB_API}/${endpoint}?${params}`, {
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return null; // Network failure → no enrichment; the caller counts it.
  }
  if (!res.ok) return null;

  let payload: { results?: TmdbSearchResult[] };
  try {
    payload = (await res.json()) as { results?: TmdbSearchResult[] };
  } catch {
    return null;
  }
  const results = Array.isArray(payload.results) ? payload.results : [];
  // Only results with a poster are useful to us (the backfill selects exactly
  // the poster-less rows). Scan a few candidates so one poster-less top hit
  // doesn't block a good match ranked just below it.
  const candidates = results.filter(
    (r) => r && Number.isInteger(r.id) && r.id > 0 && r.poster_path,
  );
  if (candidates.length === 0) return null;

  const wanted = normalizeTitle(title);
  const match =
    candidates.find((r) =>
      [r.title, r.name, r.original_title, r.original_name]
        .filter(Boolean)
        .some((t) => normalizeTitle(t as string) === wanted),
    ) ?? candidates[0]!;

  return {
    tmdbId: match.id,
    posterUrl: `https://image.tmdb.org/t/p/${POSTER_SIZE}${match.poster_path}`,
    backdropUrl: match.backdrop_path
      ? `https://image.tmdb.org/t/p/${BACKDROP_SIZE}${match.backdrop_path}`
      : null,
    releaseDate:
      input.kind === 'series'
        ? isoDateOrNull(match.first_air_date)
        : isoDateOrNull(match.release_date),
  };
}

/**
 * Enrich a screen work via TMDB title search. Returns null when enrichment
 * is unavailable (no key, blank title, no match, network/API failure).
 */
export async function enrichScreenWork(
  apiKey: string | undefined,
  input: TmdbSearchInput,
  fetcher: TmdbFetcher = fetch,
): Promise<TmdbEnrichment | null> {
  if (!apiKey) {
    // No key → no network, no cost, no failure. Graceful by design.
    return null;
  }
  return searchTmdb(apiKey, input, fetcher);
}

/** Env-shaped convenience wrapper (accepts the worker's Env). */
export async function enrichScreenWorkFromEnv(
  env: TmdbEnv,
  input: TmdbSearchInput,
  fetcher: TmdbFetcher = fetch,
): Promise<TmdbEnrichment | null> {
  return enrichScreenWork(env.TMDB_API_KEY, input, fetcher);
}
