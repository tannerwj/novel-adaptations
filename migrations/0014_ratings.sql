-- 0014_ratings.sql — user star ratings (1–5) on books and screen works.
-- Ratings are SEPARATE from votes (src/votes): votes feed the Most Wanted
-- leaderboard; ratings are a per-title 1–5 crowd score.
-- Track 1.

CREATE TABLE IF NOT EXISTS ratings (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('book', 'screen_work')),
  target_id INTEGER NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE (user_id, target_type, target_id)
);

CREATE INDEX IF NOT EXISTS idx_ratings_target
  ON ratings (target_type, target_id);

-- Hourly per-user rating counter: max 60 rating writes per rolling hour
-- (see checkRatingsRate in src/ratings/db.ts). Same pattern as
-- magic_link_rate: keyed on (user_id, UTC hour bucket).
CREATE TABLE IF NOT EXISTS ratings_rate (
  user_id INTEGER NOT NULL,
  hour TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, hour)
);
