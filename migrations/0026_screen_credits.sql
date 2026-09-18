-- 0026: screen-work credits + audience scores (TMDB enrichment wave).
--
-- cast_json: JSON array of up to 8 top-billed cast members, each
--   { "name": str, "character": str, "profile_path": str|null }.
--   profile_path is the TMDB profile image path (prepend
--   https://image.tmdb.org/t/p/w185). Stored as TEXT; parsed at read time.
-- director: film director name (crew job = 'Director', first match).
-- creators: series creators, comma-joined (tv 'created_by').
-- tmdb_vote_average / tmdb_vote_count: TMDB audience score at enrichment time.
--   Displayed as "TMDB audience score" — real external data, never mixed with
--   the site's own 5-star ratings.

ALTER TABLE screen_works ADD COLUMN cast_json TEXT;
ALTER TABLE screen_works ADD COLUMN director TEXT;
ALTER TABLE screen_works ADD COLUMN creators TEXT;
ALTER TABLE screen_works ADD COLUMN tmdb_vote_average REAL;
ALTER TABLE screen_works ADD COLUMN tmdb_vote_count INTEGER;
