-- 0012_search_indexes.sql — Track 3 (search): supporting indexes for the
-- /search LIKE queries in src/search.tsx.
--
-- Decision: parameterized LIKE instead of FTS5 (documented in
-- TRACK3_NOTES.md). The title indexes help prefix-ordered scans and any
-- future prefix autocomplete; substring matches still scan the table, which
-- is trivially fast at this catalog's scale.
CREATE INDEX IF NOT EXISTS idx_books_title ON books (title);
CREATE INDEX IF NOT EXISTS idx_screen_works_title ON screen_works (title);
