-- 0022: close the holes in the 0021 status/release-date invariant.
--
-- 0021's adaptations trigger only fires BEFORE UPDATE OF status, so two
-- writes could still produce 'released' with a bad date:
--   1. UPDATE screen_works SET release_date = <future/NULL> — the linked
--      adaptations keep status='released' with no trigger firing.
--   2. UPDATE adaptations SET screen_work_id = <other> — reassigning a
--      'released' adaptation to a work with no (or a future) release_date.
--
-- This migration:
--   a) recreates the adaptations trigger to fire on status OR screen_work_id
--      changes, checking the NEW work's date;
--   b) adds a BEFORE UPDATE OF release_date trigger on screen_works that
--      aborts when any linked adaptation is 'released' and the new date is
--      NULL or in the future.
--
-- The app layer (releasedAdaptationsViolatedByDate in src/db.ts) rejects the
-- same edits with a clear message; these triggers are the backstop for bulk
-- imports and offline scripts that write SQL directly.

DROP TRIGGER IF EXISTS trg_adaptations_released_update;

CREATE TRIGGER trg_adaptations_released_update
BEFORE UPDATE OF status, screen_work_id ON adaptations
FOR EACH ROW
WHEN NEW.status = 'released'
  AND (
    (SELECT release_date FROM screen_works WHERE id = NEW.screen_work_id) IS NULL
    OR (SELECT release_date FROM screen_works WHERE id = NEW.screen_work_id) > date('now')
  )
BEGIN
  SELECT RAISE(ABORT, 'status=released requires screen_works.release_date on or before today');
END;

CREATE TRIGGER IF NOT EXISTS trg_screen_works_release_date_update
BEFORE UPDATE OF release_date ON screen_works
FOR EACH ROW
WHEN (NEW.release_date IS NULL OR NEW.release_date > date('now'))
  AND EXISTS (
    SELECT 1 FROM adaptations
    WHERE screen_work_id = NEW.id AND status = 'released'
  )
BEGIN
  SELECT RAISE(ABORT, 'release_date change would invalidate linked released adaptations — change their status first');
END;
