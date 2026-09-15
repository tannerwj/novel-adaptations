-- 0015_reviews.sql — Track 2: spoiler-safe user reviews.
--
-- One review per (user, target); reviews target either a book or a screen
-- work. Spoiler-flagged bodies are blurred client-side via has_spoilers.
-- Spam protection is a per-user hourly rate limit (reviews_rate, mirrored
-- on the magic_link_rate pattern in 0005_auth_votes.sql).
--
-- All objects use IF NOT EXISTS so the migration is idempotent.

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('book', 'screen_work')),
  target_id INTEGER NOT NULL,
  title TEXT,
  body TEXT NOT NULL,
  has_spoilers INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE (user_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_reviews_target
  ON reviews (target_type, target_id, created_at);

-- Hourly per-user review counter: max 20 submissions per rolling hour
-- (see checkReviewsRate in src/reviews/db.ts).
CREATE TABLE IF NOT EXISTS reviews_rate (
  user_id INTEGER NOT NULL,
  hour TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, hour)
);
