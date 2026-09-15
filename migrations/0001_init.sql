-- 0001_init.sql — core schema for Novel Adaptations (Phase 1).
-- users / votes are stubs for Phase 2; the browse + detail UI only reads
-- books, screen_works, adaptations, news_items.

CREATE TABLE books (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  authors TEXT NOT NULL,
  cover_url TEXT,
  pub_date TEXT,
  isbn TEXT,
  openlibrary_id TEXT,
  googlebooks_id TEXT
);

CREATE TABLE screen_works (
  id INTEGER PRIMARY KEY,
  tmdb_id INTEGER,
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('film', 'series')),
  poster_url TEXT,
  release_date TEXT
);

CREATE TABLE adaptations (
  id INTEGER PRIMARY KEY,
  book_id INTEGER NOT NULL REFERENCES books (id),
  screen_work_id INTEGER NOT NULL REFERENCES screen_works (id),
  status TEXT NOT NULL CHECK (status IN (
    'rumored', 'optioned', 'in_development', 'filming',
    'post_production', 'released', 'cancelled'
  )),
  source_url TEXT
);

CREATE INDEX idx_adaptations_book_id ON adaptations (book_id);
CREATE INDEX idx_adaptations_screen_work_id ON adaptations (screen_work_id);
CREATE INDEX idx_adaptations_status ON adaptations (status);

CREATE TABLE news_items (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  source TEXT,
  trust_tier TEXT NOT NULL CHECK (trust_tier IN ('trusted', 'rumor')),
  published_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'dismissed'))
);

-- Phase 2 stubs: accounts and "want this adaptation" votes.
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE votes (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id),
  book_id INTEGER NOT NULL REFERENCES books (id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, book_id)
);
