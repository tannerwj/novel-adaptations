-- 0010_feedback.sql — Track D: public feedback + admin triage queue.
--
-- All tables use CREATE TABLE IF NOT EXISTS so the migration is idempotent.
-- Anonymous submission is allowed (no login wall); spam protection is a
-- per-IP hourly rate limit (feedback_rate, mirrored on the magic_link_rate
-- pattern in 0005_auth_votes.sql).
--
-- Privacy: the admin list shows each reporter's submitted email as-is — it
-- is the reporter's own address, never another user's account data.

CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users (id),
  email TEXT,
  type TEXT NOT NULL CHECK (type IN ('feature','adaptation_tip','correction','other')),
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  proof_url TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','reviewed','done')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback (status);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback (created_at);

-- Hourly per-IP feedback counter: max 5 submissions per rolling hour
-- (see checkFeedbackRate in src/feedback/db.ts).
CREATE TABLE IF NOT EXISTS feedback_rate (
  ip TEXT NOT NULL,
  hour TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip, hour)
);
