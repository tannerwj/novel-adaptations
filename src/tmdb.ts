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
  /** Real TMDB overview text (trimmed), or null when TMDB has none. */
  overview: string | null;
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
  overview?: string | null;
}

/** Strict `YYYY-MM-DD`, the only shape we persist as a release date. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** TMDB date field (may be empty/malformed) → validated date or null. */
function isoDateOrNull(raw: string | null | undefined): string | null {
  return typeof raw === 'string' && ISO_DATE.test(raw) ? raw : null;
}

/**
 * Bound for every TMDB HTTP call, headers *and* body. The timer used to stop
 * at headers, leaving a stalled body unbounded.
 */
export const TMDB_TIMEOUT_MS = 10_000;

/**
 * Discriminated enrichment outcome, so callers can tell a genuine no-match
 * from a retryable failure and from "nothing was even tried":
 * - hit: persist the enrichment
 * - no-match: the lookup ran and found nothing — safe to count an attempt
 * - not-attempted: no API key or blank input — nothing was tried
 * - failed: network/API failure — retryable, must NOT burn an attempt
 */
export type EnrichOutcome =
  | { status: 'hit'; hit: TmdbEnrichment }
  | { status: 'no-match' }
  | { status: 'not-attempted' }
  | { status: 'failed'; message?: string };

/**
 * GET JSON from TMDB with the deadline held through body consumption.
 * Returns the HTTP status with the parsed body (null when unparseable).
 * Throws on network failure or timeout — including a stalled body.
 */
export async function tmdbGetJson(
  url: string,
  fetcher: TmdbFetcher,
): Promise<{ status: number; json: unknown }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TMDB_TIMEOUT_MS);
  try {
    const res = await fetcher(url, { signal: controller.signal });
    if (!res.ok) return { status: res.status, json: null };
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  } finally {
    clearTimeout(timeout);
  }
}

/** TMDB movie/TV result → the enrichment shape we persist. */
function toEnrichment(match: TmdbSearchResult, kind: 'film' | 'series'): TmdbEnrichment {
  return {
    tmdbId: match.id,
    posterUrl: `https://image.tmdb.org/t/p/${POSTER_SIZE}${match.poster_path}`,
    backdropUrl: match.backdrop_path
      ? `https://image.tmdb.org/t/p/${BACKDROP_SIZE}${match.backdrop_path}`
      : null,
    overview:
      typeof match.overview === 'string' && match.overview.trim()
        ? match.overview.trim()
        : null,
    releaseDate:
      kind === 'series'
        ? isoDateOrNull(match.first_air_date)
        : isoDateOrNull(match.release_date),
  };
}

/**
 * Search TMDB for a title. Uses the kind-specific endpoint — /search/movie
 * for films, /search/tv for series — rather than /search/multi, so a film
 * can never match a TV series of the same name (or a person/collection).
 * The year is passed as a search filter (year / first_air_date_year) when
 * known, which is the standard way to disambiguate remakes.
 *
 * Picks the first result carrying a poster whose normalized title matches
 * the query and whose own release year is within ±1 of the known year.
 * Returns a discriminated EnrichOutcome: 'hit', 'no-match', 'not-attempted'
 * (no key / blank title), or 'failed' (retryable network/API failure).
 *
 * Year safety: TMDB's year filter is not bulletproof, so every hit is
 * post-verified — a hit whose own release year differs from the known year
 * by more than one is rejected (release years legitimately disagree by a
 * year across sources: festival premiere vs wide release). When the
 * year-filtered search finds nothing, one unfiltered retry scans every
 * exact-title hit for one within ±1 year (remake versions rank below the
 * popular original, so the top hit alone isn't enough) — never a guess.
 */
export async function searchTmdb(
  apiKey: string | undefined,
  input: TmdbSearchInput,
  fetcher: TmdbFetcher = fetch,
): Promise<EnrichOutcome> {
  const title = input.title.trim();
  if (!apiKey || !title) return { status: 'not-attempted' };
  const year =
    input.year && Number.isInteger(input.year) && input.year > 1800
      ? input.year
      : null;

  const endpoint = input.kind === 'series' ? 'search/tv' : 'search/movie';
  const yearParam = input.kind === 'series' ? 'first_air_date_year' : 'year';
  const wanted = normalizeTitle(title);

  const doSearch = async (
    withYear: boolean,
  ): Promise<TmdbSearchResult[]> => {
    const params = new URLSearchParams({
      api_key: apiKey,
      query: title,
      language: 'en-US',
      page: '1',
      include_adult: 'false',
    });
    if (withYear && year) params.set(yearParam, String(year));

    // Transport failures (network, timeout, stalled body) throw — the
    // caller maps them to a retryable 'failed' outcome, not a no-match.
    const { status, json } = await tmdbGetJson(
      `${TMDB_API}/${endpoint}?${params}`,
      fetcher,
    );
    if (status !== 200) throw new Error(`TMDB search HTTP ${status}`);
    const payload = json as { results?: TmdbSearchResult[] } | null;
    const results = Array.isArray(payload?.results) ? payload.results : [];
    // Only results with a poster are useful to us (the backfill selects exactly
    // the poster-less rows). Scan a few candidates so one poster-less top hit
    // doesn't block a good match ranked just below it.
    return results.filter(
      (r) => r && Number.isInteger(r.id) && r.id > 0 && r.poster_path,
    );
  };

  /** Normalized title equality against every title variant TMDB returns. */
  const isTitleMatch = (r: TmdbSearchResult): boolean =>
    [r.title, r.name, r.original_title, r.original_name]
      .filter(Boolean)
      .some((t) => normalizeTitle(t as string) === wanted);

  /** The hit's own release year, for post-verification against the known year. */
  const hitYear = (e: TmdbEnrichment): number | null =>
    e.releaseDate && /^\d{4}/.test(e.releaseDate)
      ? Number(e.releaseDate.slice(0, 4))
      : null;
  const yearOk = (e: TmdbEnrichment): boolean => {
    if (!year) return true; // nothing to verify against — accept title match
    const hy = hitYear(e);
    return hy !== null && Math.abs(hy - year) <= 1;
  };

  // Primary: year-filtered search — exact title + post-verified year only.
  // Never a guess: a non-exact title is skipped even when its year fits.
  try {
    for (const r of await doSearch(true)) {
      if (!isTitleMatch(r)) continue;
      const e = toEnrichment(r, input.kind);
      if (yearOk(e)) return { status: 'hit', hit: e };
    }
    // Fallback: unfiltered search, scanning every exact-title hit for one
    // within ±1 year (remake versions rank below the popular original, so the
    // top hit alone isn't enough). Still never a guess.
    if (year) {
      for (const r of await doSearch(false)) {
        if (!isTitleMatch(r)) continue;
        const e = toEnrichment(r, input.kind);
        if (yearOk(e)) return { status: 'hit', hit: e };
      }
    }
    return { status: 'no-match' };
  } catch (e) {
    return { status: 'failed', message: (e as Error).message };
  }
}

/**
 * Enrich a screen work via TMDB title search. Returns a discriminated
 * outcome (see EnrichOutcome) so callers can tell a genuine no-match from
 * a retryable failure and from "nothing was even tried".
 */
export async function enrichScreenWork(
  apiKey: string | undefined,
  input: TmdbSearchInput,
  fetcher: TmdbFetcher = fetch,
): Promise<EnrichOutcome> {
  return searchTmdb(apiKey, input, fetcher);
}

/** Env-shaped convenience wrapper (accepts the worker's Env). */
export async function enrichScreenWorkFromEnv(
  env: TmdbEnv,
  input: TmdbSearchInput,
  fetcher: TmdbFetcher = fetch,
): Promise<EnrichOutcome> {
  return enrichScreenWork(env.TMDB_API_KEY, input, fetcher);
}

/**
 * Resolve an IMDb id (tt...) to its TMDB record via the /find endpoint with
 * external_source=imdb_id — an exact identity lookup, never a title guess.
 * The hit carries its kind ('film' from movie_results, 'series' from
 * tv_results). A 404 / empty result set is a no-match; anything else non-OK
 * or a transport failure is retryable.
 */
export type FindOutcome =
  | { status: 'hit'; hit: TmdbEnrichment; kind: 'film' | 'series'; title: string }
  | { status: 'no-match' }
  | { status: 'not-attempted' }
  | { status: 'failed'; message?: string };

export async function findByImdbId(
  apiKey: string | undefined,
  imdbId: string,
  fetcher: TmdbFetcher = fetch,
): Promise<FindOutcome> {
  if (!apiKey || !/^tt\d+$/.test(imdbId)) return { status: 'not-attempted' };
  const params = new URLSearchParams({
    external_source: 'imdb_id',
    language: 'en-US',
  });
  params.set('api_key', apiKey);
  try {
    const { status, json } = await tmdbGetJson(
      `${TMDB_API}/find/${imdbId}?${params}`,
      fetcher,
    );
    if (status === 404) return { status: 'no-match' };
    if (status !== 200) return { status: 'failed', message: `TMDB HTTP ${status}` };
    const payload = json as {
      movie_results?: TmdbSearchResult[];
      tv_results?: TmdbSearchResult[];
    } | null;
    const movie = payload?.movie_results?.find(
      (r) => r && Number.isInteger(r.id) && r.poster_path,
    );
    if (movie) {
      return {
        status: 'hit',
        hit: toEnrichment(movie, 'film'),
        kind: 'film',
        title: movie.title || movie.original_title || '',
      };
    }
    const tv = payload?.tv_results?.find(
      (r) => r && Number.isInteger(r.id) && r.poster_path,
    );
    if (tv) {
      return {
        status: 'hit',
        hit: toEnrichment(tv, 'series'),
        kind: 'series',
        title: tv.name || tv.original_name || '',
      };
    }
    return { status: 'no-match' };
  } catch (e) {
    return { status: 'failed', message: (e as Error).message };
  }
}

/**
 * Enrich by known TMDB id (`/movie/{id}` or `/tv/{id}`) instead of title
 * search. Used when the row already carries a tmdb_id: metadata is then
 * guaranteed to describe the stored identity, never a different title's
 * search hit. A 404 (stale id) is a no-match; anything else non-OK or a
 * transport failure is retryable.
 */
export async function fetchEnrichmentById(
  apiKey: string | undefined,
  kind: 'film' | 'series',
  tmdbId: number,
  fetcher: TmdbFetcher = fetch,
): Promise<EnrichOutcome> {
  if (!apiKey || !Number.isInteger(tmdbId) || tmdbId < 1) {
    return { status: 'not-attempted' };
  }
  const params = new URLSearchParams({ language: 'en-US' });
  params.set('api_key', apiKey);
  const endpoint = kind === 'series' ? 'tv' : 'movie';
  try {
    const { status, json } = await tmdbGetJson(
      `${TMDB_API}/${endpoint}/${tmdbId}?${params}`,
      fetcher,
    );
    if (status === 404) return { status: 'no-match' };
    if (status !== 200) return { status: 'failed', message: `TMDB HTTP ${status}` };
    const item = json as TmdbSearchResult | null;
    if (!item || !Number.isInteger(item.id) || !item.poster_path) {
      return { status: 'no-match' };
    }
    return { status: 'hit', hit: toEnrichment(item, kind) };
  } catch (e) {
    return { status: 'failed', message: (e as Error).message };
  }
}

/** One top-billed cast member extracted from TMDB credits. */
export interface TmdbCastMember {
  name: string;
  character: string;
  /** TMDB profile image path (prepend https://image.tmdb.org/t/p/w185), or null. */
  profile_path: string | null;
}

/** Credits + audience score for a screen work, from a single details call. */
export interface TmdbCredits {
  cast: TmdbCastMember[];
  /** Film only: first crew member with job 'Director'. */
  director: string | null;
  /** Series only: created_by names, comma-joined. */
  creators: string | null;
  vote_average: number | null;
  vote_count: number | null;
}

export type CreditsOutcome =
  | { status: 'hit'; credits: TmdbCredits }
  | { status: 'no-match' }
  | { status: 'not-attempted' }
  | { status: 'failed'; message?: string };

const MAX_CAST = 8;

type JsonRecord = Record<string, unknown>;

const asRecord = (v: unknown): JsonRecord | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as JsonRecord) : null;

/**
 * Pure extraction of credits + ratings from a TMDB details payload fetched
 * with `append_to_response=credits`. Unit-tested; the fetcher below is thin.
 */
export function extractCredits(
  kind: 'film' | 'series',
  payload: unknown,
): TmdbCredits {
  const p = asRecord(payload) ?? {};
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  const credits = asRecord(p.credits) ?? {};
  const castRaw = Array.isArray(credits.cast) ? credits.cast : [];
  const crewRaw = Array.isArray(credits.crew) ? credits.crew : [];
  const castOrder = (m: JsonRecord): number =>
    typeof m.order === 'number' ? m.order : Number.MAX_SAFE_INTEGER;
  const cast: TmdbCastMember[] = castRaw
    .map(asRecord)
    .filter((m): m is JsonRecord => m !== null)
    .sort((a, b) => castOrder(a) - castOrder(b))
    .slice(0, MAX_CAST)
    .map((m) => ({
      name: typeof m.name === 'string' ? m.name : '',
      character: typeof m.character === 'string' ? m.character : '',
      profile_path: typeof m.profile_path === 'string' ? m.profile_path : null,
    }))
    .filter((m) => m.name !== '');
  let director: string | null = null;
  if (kind === 'film') {
    for (const m of crewRaw) {
      const r = asRecord(m);
      if (r && r.job === 'Director' && typeof r.name === 'string') {
        director = r.name;
        break;
      }
    }
  }
  let creators: string | null = null;
  if (kind === 'series' && Array.isArray(p.created_by)) {
    const names = p.created_by
      .map(asRecord)
      .filter((c): c is JsonRecord => c !== null && typeof c.name === 'string')
      .map((c) => c.name as string);
    creators = names.length > 0 ? names.join(', ') : null;
  }
  return {
    cast,
    director,
    creators,
    vote_average: num(p.vote_average),
    vote_count: num(p.vote_count),
  };
}

/**
 * Fetch credits + audience score by known TMDB id with
 * `append_to_response=credits` — one request per title. Identity-safe: the
 * row already carries the tmdb_id, so the payload can only describe the
 * stored identity. A 404 (stale id) is a no-match; anything else non-OK or a
 * transport failure is retryable.
 */
export async function fetchCreditsById(
apiKey: string,
  kind: 'film' | 'series',
  tmdbId: number,
  fetcher: TmdbFetcher = fetch,
): Promise<CreditsOutcome> {
  if (!apiKey || !Number.isInteger(tmdbId) || tmdbId < 1) {
    return { status: 'not-attempted' };
  }
  const params = new URLSearchParams({ language: 'en-US', append_to_response: 'credits' });
  params.set('api_key', apiKey);
  const endpoint = kind === 'series' ? 'tv' : 'movie';
  try {
    const { status, json } = await tmdbGetJson(
      `${TMDB_API}/${endpoint}/${tmdbId}?${params}`,
      fetcher,
    );
    if (status === 404) return { status: 'no-match' };
    if (status !== 200) return { status: 'failed', message: `TMDB HTTP ${status}` };
    if (!json || typeof json !== 'object') return { status: 'no-match' };
    return { status: 'hit', credits: extractCredits(kind, json) };
  } catch (e) {
    return { status: 'failed', message: (e as Error).message };
  }
}
