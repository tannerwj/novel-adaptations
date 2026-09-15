-- 0003_news_pipeline.sql — news ingestion pipeline schema (Phase 3).
--
-- Rebuilds news_items: the 0001 schema was a stub (no url_hash, summary,
-- classification columns, and a trust_tier CHECK that excluded 'reputable').
-- The pipeline needs the full schema below. The table is empty in
-- production; the copy step preserves any rows that exist (e.g. local dev).
-- Legacy rows get a placeholder url_hash since the old schema had none.

CREATE TABLE news_items_new (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL,
  url_hash TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  summary TEXT,
  source TEXT NOT NULL,
  trust_tier TEXT NOT NULL CHECK (trust_tier IN ('trusted', 'reputable', 'rumor')),
  published_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'dismissed')),
  is_adaptation_news INTEGER NOT NULL DEFAULT 0,
  book_title TEXT,
  author TEXT,
  screen_kind TEXT,
  status_signal TEXT,
  confidence REAL,
  llm_model TEXT,
  needs_review INTEGER NOT NULL DEFAULT 0,
  dismiss_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO news_items_new
  (id, url, url_hash, title, source, trust_tier, published_at, status, created_at)
SELECT id, url, 'legacy-' || id, title, source, trust_tier, published_at, status,
       datetime('now')
FROM news_items;

DROP TABLE news_items;

ALTER TABLE news_items_new RENAME TO news_items;

CREATE INDEX idx_news_items_status ON news_items (status);
CREATE INDEX idx_news_items_trust_tier ON news_items (trust_tier);
CREATE INDEX idx_news_items_created_at ON news_items (created_at);

-- Feed registry + health tracking (written by the scheduled ingestor).
CREATE TABLE sources (
  name TEXT PRIMARY KEY,
  feed_url TEXT NOT NULL,
  trust_tier TEXT NOT NULL CHECK (trust_tier IN ('trusted', 'reputable', 'rumor')),
  is_active INTEGER NOT NULL DEFAULT 1,
  last_fetched_at TEXT,
  last_status TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0
);

-- Audit trail for adaptation status changes (owner promotions from the
-- curation queue, and any future pipeline-suggested changes).
CREATE TABLE adaptation_status_audit (
  id INTEGER PRIMARY KEY,
  adaptation_id INTEGER NOT NULL REFERENCES adaptations (id),
  old_status TEXT NOT NULL,
  new_status TEXT NOT NULL,
  source_url TEXT,
  news_item_id INTEGER REFERENCES news_items (id),
  changed_by TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_audit_adaptation_id ON adaptation_status_audit (adaptation_id);
