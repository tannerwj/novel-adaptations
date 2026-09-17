-- 0025_book_details_trailers.sql — richer book pages + watch-page trailers.
--
-- books.description / books.subjects come from Open Library (backfilled by
-- scripts/backfill-book-details.py; new intake rows fetch them at intake
-- time in src/intake.ts). subjects is a JSON array of subject strings.
-- screen_works.trailer_youtube_key caches the TMDB videos lookup:
--   NULL = not checked yet, '' = checked, TMDB has no trailer, otherwise
--   the YouTube video key. Served by GET /api/v1/watch/:id/trailer.

ALTER TABLE books ADD COLUMN description TEXT;
ALTER TABLE books ADD COLUMN subjects TEXT;
ALTER TABLE screen_works ADD COLUMN trailer_youtube_key TEXT;
