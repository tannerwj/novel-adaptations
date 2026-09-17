// tests/unit/news-sources.test.mjs — regression tests for finding 22.
//
// The source registry lives in D1; the SOURCES constant only seeds it.
// Guarded behaviors:
//  - seeding never overwrites DB-side feed_url / trust_tier edits
//  - only active sources (or paused ones due for recheck) are fetched
//  - a paused source is rechecked after 7 days without an attempt
//  - a successful recheck resets the failure streak and reactivates
//  - failures auto-pause at the threshold; every attempt stamps
//    last_attempt_at
//
// Run: node --test "tests/unit/*.test.mjs"

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { register } from 'node:module';

register(new URL('./hooks/extensionless.mjs', import.meta.url));

const {
  SOURCES,
  seedSources,
  selectSourcesToFetch,
  recordSourceSuccess,
  recordSourceFailure,
} = await import('../../src/news/ingest.ts');

/** D1-shaped adapter over node:sqlite. */
function d1(sqlite) {
  const execBound = (sql, args) => {
    const stmt = sqlite.prepare(sql);
    if (/^\s*SELECT/i.test(sql)) return { results: stmt.all(...args) };
    const info = stmt.run(...args);
    return { success: true, meta: { changes: Number(info.changes) } };
  };
  const boundStmt = (sql, args) => ({
    all: async () => ({ results: execBound(sql, args).results ?? [] }),
    first: async () => (execBound(sql, args).results ?? [])[0] ?? null,
    run: async () => execBound(sql, args),
  });
  return { prepare: (sql) => ({ bind: (...args) => boundStmt(sql, args) }) };
}

function seed() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE sources (
      name TEXT PRIMARY KEY,
      feed_url TEXT NOT NULL,
      trust_tier TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      last_fetched_at TEXT,
      last_attempt_at TEXT,
      last_status TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0
    );
  `);
  return sqlite;
}

const src = (name) => ({
  name,
  feed_url: `https://${name}.example/feed`,
  trust_tier: 'reputable',
});

function row(sqlite, name) {
  return sqlite.prepare('SELECT * FROM sources WHERE name = ?').get(name);
}

test('seedSources inserts all SOURCES without clobbering DB-side edits', async () => {
  const sqlite = seed();
  const db = d1(sqlite);
  // Operator customized Deadline's feed URL in the DB.
  sqlite
    .prepare(
      "INSERT INTO sources (name, feed_url, trust_tier, is_active) VALUES ('Deadline', 'https://custom.example/deadline.xml', 'trusted', 1)",
    )
    .run();
  await seedSources(db);
  const names = sqlite
    .prepare('SELECT name FROM sources')
    .all()
    .map((r) => r.name);
  assert.deepEqual(new Set(names), new Set(SOURCES.map((s) => s.name)));
  // The DB-side edit survived the reseed.
  assert.equal(row(sqlite, 'Deadline').feed_url, 'https://custom.example/deadline.xml');
});

test('selectSourcesToFetch skips recently-attempted paused sources', async () => {
  const sqlite = seed();
  const db = d1(sqlite);
  await seedSources(db);
  // Pause Variety with a recent attempt (2 days ago).
  sqlite
    .prepare(
      `UPDATE sources SET is_active = 0, last_attempt_at = datetime('now', '-2 days'),
         consecutive_failures = 5 WHERE name = 'Variety'`,
    )
    .run();
  const names = (await selectSourcesToFetch(db)).map((s) => s.name);
  assert.ok(!names.includes('Variety'), 'recently-attempted paused source must be skipped');
  assert.ok(names.includes('Deadline'), 'active sources are still fetched');
});

test('selectSourcesToFetch includes paused sources due for recheck', async () => {
  const sqlite = seed();
  const db = d1(sqlite);
  await seedSources(db);
  // Paused 8 days ago → due. Never attempted → due.
  sqlite
    .prepare(
      `UPDATE sources SET is_active = 0, last_attempt_at = datetime('now', '-8 days'),
         consecutive_failures = 5 WHERE name = 'Collider'`,
    )
    .run();
  sqlite
    .prepare(
      `UPDATE sources SET is_active = 0, last_attempt_at = NULL,
         consecutive_failures = 5 WHERE name = 'ScreenRant'`,
    )
    .run();
  const names = (await selectSourcesToFetch(db)).map((s) => s.name);
  assert.ok(names.includes('Collider'), 'paused source past the 7-day recheck is fetched');
  assert.ok(names.includes('ScreenRant'), 'paused source never attempted is fetched');
});

test('recordSourceSuccess reactivates a paused source and resets the streak', async () => {
  const sqlite = seed();
  const db = d1(sqlite);
  await seedSources(db);
  sqlite
    .prepare(
      `UPDATE sources SET is_active = 0, consecutive_failures = 5,
         last_attempt_at = datetime('now', '-8 days') WHERE name = 'Collider'`,
    )
    .run();
  const s = (await selectSourcesToFetch(db)).find((x) => x.name === 'Collider');
  await recordSourceSuccess(db, s);
  const r = row(sqlite, 'Collider');
  assert.equal(r.is_active, 1);
  assert.equal(r.consecutive_failures, 0);
  assert.equal(r.last_status, 'ok');
  assert.ok(r.last_fetched_at, 'last_fetched_at stamped');
  assert.ok(r.last_attempt_at, 'last_attempt_at stamped');
});

test('recordSourceFailure auto-pauses at the threshold and stamps attempts', async () => {
  const sqlite = seed();
  const db = d1(sqlite);
  await seedSources(db);
  const s = src('Flaky');
  sqlite
    .prepare(
      "INSERT INTO sources (name, feed_url, trust_tier, consecutive_failures) VALUES ('Flaky', 'https://flaky.example/f', 'rumor', 3)",
    )
    .run();
  await recordSourceFailure(db, s);
  let r = row(sqlite, 'Flaky');
  assert.equal(r.consecutive_failures, 4);
  assert.equal(r.is_active, 1, 'not yet at threshold');
  assert.equal(r.last_status, 'error');
  assert.ok(r.last_attempt_at, 'every attempt stamps last_attempt_at');

  await recordSourceFailure(db, s);
  r = row(sqlite, 'Flaky');
  assert.equal(r.consecutive_failures, 5);
  assert.equal(r.is_active, 0, 'auto-paused at 5 consecutive failures');
});
