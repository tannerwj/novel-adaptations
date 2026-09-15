-- 0008_shelves_read_watched.sql — split the 'done' shelf into 'read' and 'watched'.
--
-- SQLite can't ALTER a CHECK constraint, so shelf_items is rebuilt: create the
-- new table, copy every row with the done→read/done→watched mapping, drop the
-- old table, and rename. Applies cleanly after 0001–0007 on a fresh DB.
--
-- Design decision: a 'done' entry on a book means the book was READ, and a
-- 'done' entry on an adaptation means it was WATCHED (that's the domain
-- meaning of "done" for each target type), so the migration re-resolves each
-- done row by its target_type rather than collapsing everything to one shelf.

CREATE TABLE shelf_items_new (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id),
  target_type TEXT NOT NULL CHECK (target_type IN ('book', 'adaptation')),
  target_id INTEGER NOT NULL,
  shelf TEXT NOT NULL CHECK (shelf IN ('want_to_read', 'read', 'want_to_watch', 'watched')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, target_type, target_id)
);

INSERT INTO shelf_items_new (id, user_id, target_type, target_id, shelf, created_at)
SELECT id, user_id, target_type, target_id,
       CASE
         WHEN shelf = 'done' AND target_type = 'book' THEN 'read'
         WHEN shelf = 'done' AND target_type = 'adaptation' THEN 'watched'
         ELSE shelf
       END,
       created_at
  FROM shelf_items;

DROP TABLE shelf_items;
ALTER TABLE shelf_items_new RENAME TO shelf_items;
CREATE INDEX IF NOT EXISTS idx_shelf_items_user ON shelf_items (user_id);
