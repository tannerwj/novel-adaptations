-- 0024: track the last fetch attempt per news source (success or failure).
--
-- last_fetched_at keeps its meaning (last SUCCESSFUL fetch, shown in the
-- admin sources table). last_attempt_at records every attempt and drives
-- the auto-pause recheck: a paused source is retried only when its last
-- attempt is older than the recheck cooldown (see src/news/ingest.ts).
-- Without it, a source failing since seeding (last_fetched_at IS NULL)
-- would be rechecked on every run, defeating the pause.
--
-- Additive: plain ADD COLUMN, no backfill (NULL = never attempted).

ALTER TABLE sources ADD COLUMN last_attempt_at TEXT;
