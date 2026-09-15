-- 0018_lists.sql — Track 5: shareable user lists.
--
-- A list is a user-owned, ordered collection of books and/or screen works.
-- Public lists get a unique, unguessable slug and are viewable at
-- /lists/:slug (with OG tags for sharing); private lists 404 for non-owners.
--
-- All statements use IF NOT EXISTS so the migration is idempotent and
-- applies cleanly to a fresh SQLite database.

CREATE TABLE IF NOT EXISTS lists (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  is_public INTEGER NOT NULL DEFAULT 1,
  slug TEXT NOT NULL UNIQUE,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS list_items (
  id INTEGER PRIMARY KEY,
  list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('book', 'screen_work')),
  target_id INTEGER NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (list_id, target_type, target_id)
);

CREATE INDEX IF NOT EXISTS idx_lists_user_id ON lists (user_id);
CREATE INDEX IF NOT EXISTS idx_lists_slug ON lists (slug);
CREATE INDEX IF NOT EXISTS idx_list_items_list_position ON list_items (list_id, position);

-- Hourly per-user list-creation counter: max 20 lists per rolling hour
-- (see checkListRate in src/lists/db.ts). Mirrors the magic_link_rate
-- pattern in 0005_auth_votes.sql.
CREATE TABLE IF NOT EXISTS lists_rate (
  user_id INTEGER NOT NULL,
  hour TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, hour)
);
