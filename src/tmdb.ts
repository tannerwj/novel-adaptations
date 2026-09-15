/**
 * src/tmdb.ts — TMDB enrichment for screen works (STUB).
 *
 * Purpose: given a TMDB id (screen_works.tmdb_id), fetch poster/backdrop/
 * release metadata from the TMDB API and return the values we persist on
 * screen_works (poster_url, etc.).
 *
 * This file is intentionally a stub: it performs NO network calls when the
 * API key is absent, and returns null. The coordinator wires
 * `TMDB_API_KEY?: string` onto the worker Env (wrangler secret); Track A/B
 * pass the full `Env` here — this stub accepts any env with an optional
 * TMDB_API_KEY so it stays decoupled.
 */

export interface TmdbEnv {
  /** Set via `wrangler secret put TMDB_API_KEY`. Absent → enrichment is a no-op. */
  TMDB_API_KEY?: string;
}

/**
 * Enrich a screen work via TMDB. Returns null when enrichment is unavailable
 * (no key, invalid id, or — for now — always; see TODO).
 *
 * TODO (future, when TMDB_API_KEY is set):
 *   1. Widen the return type to `Promise<TmdbEnrichment | null>`.
 *   2. Detect kind: try `/3/tv/{tmdbId}` and `/3/movie/{tmdbId}`
 *      (append_to_response=credits). The canonical stored kind
 *      (film | series) disambiguates which endpoint to trust.
 *   3. Map fields:
 *        poster_path  → `https://image.tmdb.org/t/p/w500{poster_path}`  (screen_works.poster_url)
 *        backdrop_path → `https://image.tmdb.org/t/p/w1280{backdrop_path}` (hero backdrops)
 *        release_date / first_air_date → release_date
 *        overview → synopsis (new column if we want it)
 *   4. Cache aggressively (KV or D1): ~40 req/10s on the free tier.
 *      Respect rate limits; never call without a key.
 *   5. Attribution: TMDB requires "This product uses the TMDB API" credit —
 *      the Layout footer is the natural home for it.
 */
export async function enrichScreenWork(env: TmdbEnv, tmdbId: number): Promise<null> {
  if (!env.TMDB_API_KEY) {
    // No key → no network, no cost, no failure. Graceful by design.
    return null;
  }
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    return null;
  }
  // Stub: even with a key, enrichment is not implemented yet.
  // Implement the TODO above to go live.
  return null;
}
