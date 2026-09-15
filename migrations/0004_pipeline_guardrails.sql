-- 0004_pipeline_guardrails.sql — observability for the caution-first news pipeline (Track A).
--
-- `pipeline_runs` records every scheduled run (ran / disabled / error) so the
-- owner can audit exactly what the autonomous pipeline did without trusting
-- logs. Applies cleanly after 0001–0003 on a fresh DB.

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('ran', 'disabled', 'error')),
  feeds_ok INTEGER NOT NULL DEFAULT 0,
  feeds_failed INTEGER NOT NULL DEFAULT 0,
  items_fetched INTEGER NOT NULL DEFAULT 0,
  items_new INTEGER NOT NULL DEFAULT 0,
  items_skipped_cap INTEGER NOT NULL DEFAULT 0,
  llm_calls INTEGER NOT NULL DEFAULT 0,
  errors TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status ON pipeline_runs (status);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_started_at ON pipeline_runs (started_at);
