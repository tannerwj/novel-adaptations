-- 0009_screenwork_extras.sql — forward-affordance columns for the /watch/:id
-- screen-work pages and future affiliate links.
--
-- * screen_works.purchase_url_screen / books.purchase_url_book: nullable
--   holders for affiliate or purchase links (Amazon Associates for books,
--   where-to-watch/purchase for screen works). They are STORED but NOT
--   rendered by the UI yet — affiliate disclosure + UI ship later
--   (see docs/DESIGN.md roadmap note).
-- * screen_works.synopsis: populated by future TMDB enrichment. /watch/:id
--   pages render a graceful "coming soon" placeholder until then.

ALTER TABLE screen_works ADD COLUMN purchase_url_screen TEXT;

ALTER TABLE books ADD COLUMN purchase_url_book TEXT;

ALTER TABLE screen_works ADD COLUMN synopsis TEXT;
