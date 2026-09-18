-- 0027: Wikipedia expansion candidates.
--
-- One row per (book, film) pair scraped from Wikipedia's "fiction works made
-- into feature films" lists. A scheduled worker drains the queue: each
-- candidate is resolved against Open Library (book, with author evidence)
-- and TMDB (film, with year check); only candidates where BOTH sides match
-- become catalog records. Anything else is marked skipped/failed with a
-- reason, so the queue is fully auditable and the run is idempotent.
CREATE TABLE wiki_expansion_candidates (
  id INTEGER PRIMARY KEY,
  book_title TEXT NOT NULL,
  book_year INTEGER,
  authors TEXT NOT NULL,
  film_title TEXT NOT NULL,
  film_year INTEGER,
  source_list TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'created', 'skipped', 'failed')),
  reason TEXT,
  ol_work_key TEXT,
  tmdb_id INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  processed_at TEXT
);
CREATE INDEX idx_wiki_candidates_status ON wiki_expansion_candidates (status, id);
CREATE UNIQUE INDEX idx_wiki_candidates_pair
  ON wiki_expansion_candidates (lower(book_title), lower(film_title), film_year);

-- One row per scrape run, so the scheduled bootstrap scrapes once and never
-- re-scrapes on a schedule (a zero-candidate run is retried after 24h).
CREATE TABLE wiki_expansion_runs (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  candidates_added INTEGER NOT NULL DEFAULT 0
);
