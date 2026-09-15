-- 0006_tmdb_enrichment.sql — TMDB backfill columns on screen_works.
--
-- screen_works.tmdb_id and screen_works.poster_url already exist (0001_init.sql);
-- this adds backdrop_url for the hero/backdrop images returned by TMDB enrichment.
-- (If this chain ever runs against a legacy DB where tmdb_id is missing, the
-- backfill still works; the column predates this migration.)

ALTER TABLE screen_works ADD COLUMN backdrop_url TEXT;
