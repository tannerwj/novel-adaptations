-- 0020: SEO-friendly permalink slugs for books, screen_works, and adaptations.
--
-- Slugs are deterministic (slugified title [+ year | author], with a numeric
-- suffix on collisions) and backfilled by an offline script after apply.
-- The worker resolves both numeric IDs (301 → slug) and slugs on detail
-- routes; API detail endpoints accept either.

ALTER TABLE books ADD COLUMN slug TEXT;
ALTER TABLE screen_works ADD COLUMN slug TEXT;
ALTER TABLE adaptations ADD COLUMN slug TEXT;

-- Nullable so the backfill can run after the column lands; SQLite allows
-- multiple NULLs under a UNIQUE index, and every row gets a slug.
CREATE UNIQUE INDEX idx_books_slug ON books(slug);
CREATE UNIQUE INDEX idx_screen_works_slug ON screen_works(slug);
CREATE UNIQUE INDEX idx_adaptations_slug ON adaptations(slug);
