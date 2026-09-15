-- Migration 0011: cache for TMDB watch-provider data (TRACK 2).
--
-- Where-to-watch (stream/rent/buy) comes from TMDB's /watch/providers
-- endpoint, but a TMDB fetch per page view is wasteful and slow. This table
-- caches the parsed provider payload per screen work; src/watch_providers.ts
-- refreshes it at most once every 7 days (stale-while-revalidate, so the
-- page never waits on a refresh).

CREATE TABLE IF NOT EXISTS watch_provider_cache (
  screen_work_id INTEGER PRIMARY KEY REFERENCES screen_works (id) ON DELETE CASCADE,
  providers_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
