-- 0005_auth_votes.sql — Phase 2: passwordless accounts (magic-link), sessions,
-- "Make it a movie" votes, and user shelves.
--
-- All tables use CREATE TABLE IF NOT EXISTS so the migration is idempotent.
-- Tokens are stored only as SHA-256 hashes (see src/auth/crypto.ts).

-- Every account, identified by a unique email address.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Single-use magic-link tokens. Only the hash is stored; the raw token goes
-- out in the email link and is never persisted.
CREATE TABLE IF NOT EXISTS magic_tokens (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_magic_tokens_hash ON magic_tokens (token_hash);

-- Long-lived session tokens (na_session cookie). Only the hash is stored.
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_hash ON sessions (token_hash);

-- One vote per user per book, withdrawable. The Most Wanted leaderboard is a
-- COUNT(*) over this table (see src/votes/db.ts).
CREATE TABLE IF NOT EXISTS votes (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id),
  book_id INTEGER NOT NULL REFERENCES books (id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, book_id)
);
CREATE INDEX IF NOT EXISTS idx_votes_book_id ON votes (book_id);

-- User shelves: want_to_read / want_to_watch / done, attached to a book or an
-- adaptation. One shelf entry per (user, target).
CREATE TABLE IF NOT EXISTS shelf_items (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id),
  target_type TEXT NOT NULL CHECK (target_type IN ('book', 'adaptation')),
  target_id INTEGER NOT NULL,
  shelf TEXT NOT NULL CHECK (shelf IN ('want_to_read', 'want_to_watch', 'done')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_shelf_items_user ON shelf_items (user_id);

-- Daily per-user vote counter used by the 20-votes/day rate limit
-- (see checkVoteRate in src/votes/db.ts). Rows are one per (user, UTC day).
CREATE TABLE IF NOT EXISTS vote_rate (
  user_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

-- Hourly per-email magic-link counter: max 5 sign-in emails per rolling hour
-- (see checkMagicLinkRate in src/auth/routes.ts). Prevents email-bombing.
CREATE TABLE IF NOT EXISTS magic_link_rate (
  email TEXT NOT NULL,
  hour TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (email, hour)
);
