/**
 * src/trailers.ts — YouTube trailer lookup for screen works via TMDB /videos.
 *
 * The network boundary is the injected `fetcher`, so picking logic is pure
 * and unit-testable. The worker caches the outcome on
 * screen_works.trailer_youtube_key (NULL = unchecked, '' = TMDB has none),
 * so TMDB is hit at most once per title.
 */

import { tmdbGetJson, type TmdbFetcher } from './tmdb';

const TMDB_API = 'https://api.themoviedb.org/3';

interface TmdbVideo {
  key?: unknown;
  site?: unknown;
  type?: unknown;
  official?: unknown;
  published_at?: unknown;
}

/**
 * Pick the best YouTube trailer key from a TMDB /videos payload.
 * Preference: official YouTube Trailer → any YouTube Trailer → any YouTube
 * video (teaser, clip). Returns null when nothing playable exists.
 */
export function pickTrailerKey(payload: unknown): string | null {
  const results = (payload as { results?: unknown })?.results;
  if (!Array.isArray(results)) return null;
  const videos = results.filter(
    (v): v is TmdbVideo => !!v && typeof v === 'object',
  );
  const youTube = videos.filter(
    (v) => v.site === 'YouTube' && typeof v.key === 'string' && v.key.length > 0,
  );
  if (youTube.length === 0) return null;
  const scored = youTube.map((v) => ({
    key: v.key as string,
    score:
      (v.type === 'Trailer' ? 2 : 0) +
      (v.official === true ? 1 : 0) +
      (typeof v.published_at === 'string' ? 0 : 0),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.key ?? null;
}

export type TrailerOutcome =
  | { status: 'hit'; key: string }
  | { status: 'no-match' }
  | { status: 'not-attempted' }
  | { status: 'failed'; message: string };

/**
 * Fetch the trailer key for a TMDB movie/TV id. Returns 'not-attempted'
 * without a key, 'no-match' when TMDB has no playable video, and 'failed'
 * on network/API errors (caller should not cache failures).
 */
export async function fetchTrailerKey(
  tmdbId: number,
  kind: 'film' | 'series',
  apiKey: string,
  fetcher: TmdbFetcher = fetch,
): Promise<TrailerOutcome> {
  if (!apiKey || !Number.isInteger(tmdbId) || tmdbId <= 0) {
    return { status: 'not-attempted' };
  }
  const params = new URLSearchParams({ language: 'en-US' });
  params.set('api_key', apiKey);
  const path = kind === 'series' ? 'tv' : 'movie';
  try {
    const { status, json } = await tmdbGetJson(
      `${TMDB_API}/${path}/${tmdbId}/videos?${params}`,
      fetcher,
    );
    if (status === 404) return { status: 'no-match' };
    if (status !== 200 || !json) {
      return { status: 'failed', message: `TMDB HTTP ${status}` };
    }
    const key = pickTrailerKey(json);
    return key ? { status: 'hit', key } : { status: 'no-match' };
  } catch (e) {
    return {
      status: 'failed',
      message: e instanceof Error ? e.message : 'trailer fetch failed',
    };
  }
}
