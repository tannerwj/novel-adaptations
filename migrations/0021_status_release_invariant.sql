-- 0021: invariant — an adaptation may only be 'released' when its screen work
-- has a release_date on or before today.
--
-- Root cause it prevents: the overnight catalog expansion seeded nearly every
-- adaptation as status='released' unconditionally (see adaptation 1799,
-- "Dune: Part Three", seeded 'released' with release_date 2026-12-15 — a film
-- that had not come out). No code path checked status against the date.
--
-- SQLite CHECK constraints can't reference other tables, so this is enforced
-- with BEFORE triggers. The app layer (promoteNewsItem in src/db.ts) validates
-- first and raises a clear error; these triggers are the backstop for bulk
-- imports and offline scripts that write SQL directly.
--
-- Date comparison is lexicographic on ISO 'YYYY-MM-DD' strings (and year-only
-- 'YYYY' strings, which sort before any full date of the same year). All
-- existing release_date values are one of those two formats.

CREATE TRIGGER IF NOT EXISTS trg_adaptations_released_insert
BEFORE INSERT ON adaptations
FOR EACH ROW
WHEN NEW.status = 'released'
  AND (
    (SELECT release_date FROM screen_works WHERE id = NEW.screen_work_id) IS NULL
    OR (SELECT release_date FROM screen_works WHERE id = NEW.screen_work_id) > date('now')
  )
BEGIN
  SELECT RAISE(ABORT, 'status=released requires screen_works.release_date on or before today');
END;

CREATE TRIGGER IF NOT EXISTS trg_adaptations_released_update
BEFORE UPDATE OF status ON adaptations
FOR EACH ROW
WHEN NEW.status = 'released'
  AND (
    (SELECT release_date FROM screen_works WHERE id = NEW.screen_work_id) IS NULL
    OR (SELECT release_date FROM screen_works WHERE id = NEW.screen_work_id) > date('now')
  )
BEGIN
  SELECT RAISE(ABORT, 'status=released requires screen_works.release_date on or before today');
END;
