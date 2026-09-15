-- migrations/0017_hype.sql — Track 4: hype meter for UNRELEASED screen works.
--
-- Hype is per-user, 1–5, changeable, one level per (user, screen work).
-- The hype widget is only rendered when the work is unreleased
-- (release_date NULL/TBA or in the future); the server intentionally does NOT
-- enforce unreleased-ness on writes (see src/hype/routes.ts), so no CHECK
-- against release dates lives here either.

CREATE TABLE IF NOT EXISTS hype (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  screen_work_id INTEGER NOT NULL,
  level INTEGER NOT NULL CHECK(level BETWEEN 1 AND 5),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, screen_work_id)
);

CREATE INDEX IF NOT EXISTS idx_hype_screen_work ON hype(screen_work_id);

-- Per-user hourly write budget, same shape as magic_link_rate (migration 0005):
-- `hour` is the UTC hour bucket, e.g. '2026-09-15 17:00'. Limit: 60/hour/user.
CREATE TABLE IF NOT EXISTS hype_rate (
  user_id INTEGER NOT NULL,
  hour TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, hour)
);
