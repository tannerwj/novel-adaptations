// tests/unit/status-invariant.test.mjs — regression tests for the
// "released requires a past-or-today release_date" invariant (Dune Part Three
// was seeded status='released' with a future 2026-12-15 release_date and
// nothing checked).
//
// Run: node --test "tests/unit/*.test.mjs"
//
// Part 1 imports the real validator from src/db.ts via node type-stripping
// (node >= 23.6), so the mapping under test is the shipped code, not a copy.
// Part 2 applies the real migration SQL to an in-memory SQLite DB via
// node:sqlite and asserts the triggers fire.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const { assertReleasedStatusAllowed } = await import('../../src/db.ts');

const PAST = '2024-03-01';
const FUTURE = '2099-12-31';
const YEAR_ONLY_PAST = '1999';

test('validator allows released with a past release date', () => {
  assert.doesNotThrow(() => assertReleasedStatusAllowed(PAST));
});

test('validator allows released with a past year-only date', () => {
  assert.doesNotThrow(() => assertReleasedStatusAllowed(YEAR_ONLY_PAST));
});

test('validator rejects released with a future release date', () => {
  assert.throws(
    () => assertReleasedStatusAllowed(FUTURE),
    /in the future/,
  );
});

test('validator rejects released with no release date', () => {
  assert.throws(() => assertReleasedStatusAllowed(null), /no release_date/);
  assert.throws(() => assertReleasedStatusAllowed(''), /no release_date/);
});

function migratedDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE screen_works (id INTEGER PRIMARY KEY, title TEXT NOT NULL, release_date TEXT);
    CREATE TABLE adaptations (
      id INTEGER PRIMARY KEY,
      book_id INTEGER NOT NULL,
      screen_work_id INTEGER NOT NULL,
      status TEXT NOT NULL
    );
  `);
  const migration = readFileSync(
    new URL('../../migrations/0021_status_release_invariant.sql', import.meta.url),
    'utf8',
  );
  db.exec(migration);
  db.exec(
    `INSERT INTO screen_works (id, title, release_date) VALUES
       (1, 'Past Film', '${PAST}'),
       (2, 'Future Film', '${FUTURE}'),
       (3, 'Dateless Film', NULL)`,
  );
  return db;
}

test('trigger blocks INSERT of released with a future release_date', () => {
  const db = migratedDb();
  assert.throws(
    () =>
      db
        .prepare("INSERT INTO adaptations (book_id, screen_work_id, status) VALUES (1, 2, 'released')")
        .run(),
    /on or before today/,
  );
  db.close();
});

test('trigger blocks UPDATE to released with a future release_date', () => {
  const db = migratedDb();
  db.prepare(
    "INSERT INTO adaptations (book_id, screen_work_id, status) VALUES (1, 2, 'in_development')",
  ).run();
  assert.throws(
    () => db.prepare("UPDATE adaptations SET status = 'released' WHERE id = 1").run(),
    /on or before today/,
  );
  db.close();
});

test('trigger blocks released when release_date is missing', () => {
  const db = migratedDb();
  assert.throws(
    () =>
      db
        .prepare("INSERT INTO adaptations (book_id, screen_work_id, status) VALUES (1, 3, 'released')")
        .run(),
    /on or before today/,
  );
  db.close();
});

test('trigger allows released with a past release_date and non-released statuses freely', () => {
  const db = migratedDb();
  assert.doesNotThrow(() =>
    db
      .prepare("INSERT INTO adaptations (book_id, screen_work_id, status) VALUES (1, 1, 'released')")
      .run(),
  );
  assert.doesNotThrow(() =>
    db
      .prepare("INSERT INTO adaptations (book_id, screen_work_id, status) VALUES (1, 2, 'post_production')")
      .run(),
  );
  assert.doesNotThrow(() =>
    db.prepare("UPDATE adaptations SET status = 'post_production' WHERE id = 1").run(),
  );
  db.close();
});
