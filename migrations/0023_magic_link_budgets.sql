-- 0023: aggregate magic-link sending budgets.
--
-- The per-email hourly limit (magic_link_rate, migration 0005) stops one
-- address being email-bombed, but an attacker can fan out across many
-- addresses. This table bounds the blast radius with a single atomic
-- claim-ticket statement (see checkMagicLinkRate in src/auth/rate_limit.ts):
--
--   magic_link_claims — one row per magic-link send, keyed by UTC hour
--                       bucket (YYYY-MM-DDTHH), source IP, and email.
--
--   Budgets enforced atomically inside the INSERT:
--     per email:  5/hour   — stops one address being email-bombed
--     per IP:    20/hour   — stops a single source burning the mail budget
--     global:   500/hour   — backstop against distributed fan-out abuse
--
-- Why one row per send instead of counter tables: D1 executes each
-- statement atomically but does not transactionally group a batch, so a
-- read-counters-then-increment-counters design races (two concurrent
-- requests can both read 4/5 and both increment to 6/5). A single
-- INSERT ... SELECT ... WHERE with COUNT(*) guards is one statement, so
-- the guard and the write are indivisible: a denied request inserts
-- nothing, an allowed request inserts exactly one row, and concurrent
-- requests serialize on the statement. No partial consumption, ever.
--
-- Rows from older hour buckets are pruned best-effort by
-- checkMagicLinkRate; the table stays at roughly one hour of sends.
--
-- Additive: plain CREATE TABLE IF NOT EXISTS, no backfill, no rebuild.

CREATE TABLE IF NOT EXISTS magic_link_claims (
  id INTEGER PRIMARY KEY,
  hour TEXT NOT NULL,
  ip TEXT NOT NULL,
  email TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_magic_link_claims_hour
  ON magic_link_claims (hour);
