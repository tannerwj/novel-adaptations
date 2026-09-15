-- 0016_polls.sql — Track 3: book-vs-screen polls.
--
-- A poll implicitly exists for every adaptation (no separate polls table):
-- the "Which was better?" widget lives on each adaptation page.
-- One vote per (user, adaptation); votes are changeable via upsert.
--
-- Spam protection is a per-user hourly rate limit (polls_rate, mirrored on
-- the magic_link_rate pattern in 0005_auth_votes.sql): max 30 vote posts
-- per rolling hour per user (see checkPollsRate in src/polls/db.ts).
--
-- All statements use IF NOT EXISTS so the migration is idempotent.

CREATE TABLE IF NOT EXISTS poll_votes (
  id INTEGER PRIMARY KEY,
  adaptation_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  choice TEXT NOT NULL CHECK (choice IN ('book', 'screen', 'both', 'undecided')),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (user_id, adaptation_id)
);
CREATE INDEX IF NOT EXISTS idx_poll_votes_adaptation ON poll_votes (adaptation_id);

-- Hourly per-user poll-vote counter: max 30 POSTs per rolling hour
-- (see checkPollsRate in src/polls/db.ts).
CREATE TABLE IF NOT EXISTS polls_rate (
  user_id INTEGER NOT NULL,
  hour TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, hour)
);
