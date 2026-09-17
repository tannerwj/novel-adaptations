// tests/unit/collection-pagination.test.mjs — regression tests for finding 11.
//
// The bugs:
//  - listReviews() fetched EVERY review for a target; the API sliced the
//    page in memory. listReviewsPage() must paginate in SQL and return the
//    total from the same round trip.
//  - listListItems() resolved each item with its own sequential queries
//    (a screen work cost 3 queries via getScreenWork). listShelves() did the
//    same per entry. Both must now resolve in bounded bulk queries.
//
// The tests run the real modules against real SQLite through a small
// D1-shaped adapter that also counts prepare() calls, proving the query
// count stays flat as the collection grows.
//
// Run: node --test "tests/unit/*.test.mjs"

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { register } from 'node:module';

// src/lists/db.ts imports '../db' extensionless; resolve it like the
// worker's bundler does (see tests/unit/hooks/extensionless.mjs).
register(new URL('./hooks/extensionless.mjs', import.meta.url));

const { listReviewsPage } = await import('../../src/reviews/db.ts');
const { listListItems } = await import('../../src/lists/db.ts');
const { listShelves } = await import('../../src/votes/db.ts');

/** D1-shaped adapter over node:sqlite; counts prepare() calls. */
function d1(sqlite, counter) {
  const execBound = (sql, args) => {
    const stmt = sqlite.prepare(sql);
    if (/^\s*SELECT/i.test(sql)) return { results: stmt.all(...args) };
    const info = stmt.run(...args);
    return { success: true, meta: { changes: Number(info.changes) } };
  };
  const boundStmt = (sql, args) => ({
    all: async () => ({ results: execBound(sql, args).results ?? [] }),
    first: async (col) => {
      const rows = execBound(sql, args).results ?? [];
      const row = rows[0] ?? null;
      if (col === undefined) return row;
      return row ? row[col] : null;
    },
    run: async () => execBound(sql, args),
    _sql: sql,
    _args: args,
  });
  return {
    prepare(sql) {
      counter.count++;
      return { bind: (...args) => boundStmt(sql, args) };
    },
    batch: async (stmts) => stmts.map((s) => execBound(s._sql, s._args)),
  };
}

function seed() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);
    CREATE TABLE books (
      id INTEGER PRIMARY KEY, title TEXT, authors TEXT,
      cover_url TEXT, slug TEXT
    );
    CREATE TABLE screen_works (
      id INTEGER PRIMARY KEY, title TEXT, kind TEXT,
      poster_url TEXT, slug TEXT
    );
    CREATE TABLE adaptations (
      id INTEGER PRIMARY KEY, book_id INTEGER,
      screen_work_id INTEGER, status TEXT, slug TEXT
    );
    CREATE TABLE reviews (
      id INTEGER PRIMARY KEY, user_id INTEGER, target_type TEXT,
      target_id INTEGER, title TEXT, body TEXT,
      has_spoilers INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE lists (id INTEGER PRIMARY KEY, user_id INTEGER, title TEXT, slug TEXT);
    CREATE TABLE list_items (
      id INTEGER PRIMARY KEY, list_id INTEGER, target_type TEXT,
      target_id INTEGER, position INTEGER DEFAULT 0, note TEXT
    );
    CREATE TABLE shelf_items (
      id INTEGER PRIMARY KEY, user_id INTEGER, target_type TEXT,
      target_id INTEGER, shelf TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    INSERT INTO users (id, email) VALUES (1, 'reader@example.com');
  `);
  return sqlite;
}

// --- reviews ----------------------------------------------------------------

test('listReviewsPage paginates in SQL and returns the total', async () => {
  const sqlite = seed();
  const counter = { count: 0 };
  const db = d1(sqlite, counter);
  const ins = sqlite.prepare(
    'INSERT INTO reviews (user_id, target_type, target_id, body) VALUES (1, ?, ?, ?)',
  );
  for (let i = 1; i <= 25; i++) ins.run('book', 1, `review ${i}`);

  const p1 = await listReviewsPage(db, 'book', 1, 1, 10);
  assert.equal(p1.total, 25);
  assert.equal(p1.reviews.length, 10);
  assert.equal(p1.reviews[0].body, 'review 25'); // newest first
  assert.equal(p1.reviews[9].body, 'review 16');
  assert.equal(p1.reviews[0].authorEmail, 'reader@example.com');

  const p3 = await listReviewsPage(db, 'book', 1, 3, 10);
  assert.equal(p3.total, 25);
  assert.equal(p3.reviews.length, 5);
  assert.equal(p3.reviews[0].body, 'review 5');

  // One batch (count + page) per call — not one query per review.
  assert.ok(counter.count <= 4, `expected <= 4 prepares, got ${counter.count}`);
});

// --- list items ---------------------------------------------------------------

test('listListItems resolves mixed items in bounded queries', async () => {
  const sqlite = seed();
  const counter = { count: 0 };
  const db = d1(sqlite, counter);
  sqlite.exec(`
    INSERT INTO books (id, title, authors, cover_url, slug) VALUES
      (1, 'Dune', 'Frank Herbert', ' dune.jpg', 'dune-frank-herbert'),
      (2, 'Neuromancer', 'William Gibson', NULL, NULL);
    INSERT INTO screen_works (id, title, kind, poster_url, slug) VALUES
      (10, 'Dune: Part Two', 'film', 'dune2.jpg', 'dune-part-two-2024'),
      (11, 'Severance', 'series', NULL, NULL);
    INSERT INTO lists (id, user_id, title, slug) VALUES (1, 1, 'Sci-fi', 'sci-fi');
    INSERT INTO list_items (list_id, target_type, target_id, position) VALUES
      (1, 'book', 1, 0),
      (1, 'screen_work', 10, 1),
      (1, 'book', 2, 2),
      (1, 'screen_work', 11, 3),
      (1, 'book', 999, 4);  -- deleted target: skipped
  `);

  const items = await listListItems(db, 1);
  assert.equal(items.length, 4);
  assert.deepEqual(items.map((i) => i.title), ['Dune', 'Dune: Part Two', 'Neuromancer', 'Severance']);
  assert.equal(items[0].subtitle, 'Book · Frank Herbert');
  assert.equal(items[0].href, '/books/dune-frank-herbert');
  assert.equal(items[1].subtitle, 'Film');
  assert.equal(items[1].href, '/watch/dune-part-two-2024');
  assert.equal(items[3].subtitle, 'Series');
  assert.equal(items[3].href, '/watch/11'); // null slug falls back to id

  // 1 (items) + 1 (books IN) + 1 (works IN) — flat regardless of item count.
  assert.ok(counter.count <= 4, `expected <= 4 prepares, got ${counter.count}`);
});

// --- shelves ------------------------------------------------------------------

test('listShelves resolves books and adaptations in bounded queries', async () => {
  const sqlite = seed();
  const counter = { count: 0 };
  const db = d1(sqlite, counter);
  sqlite.exec(`
    INSERT INTO books (id, title, authors, slug) VALUES
      (1, 'Dune', 'Frank Herbert', 'dune-frank-herbert');
    INSERT INTO screen_works (id, title, kind, slug) VALUES
      (10, 'Dune: Part Two', 'film', 'dune-part-two-2024');
    INSERT INTO adaptations (id, book_id, screen_work_id, status, slug) VALUES
      (100, 1, 10, 'released', 'dune-part-two-2024');
    INSERT INTO shelf_items (user_id, target_type, target_id, shelf) VALUES
      (1, 'book', 1, 'read'),
      (1, 'adaptation', 100, 'watched'),
      (1, 'book', 999, 'want_to_read');  -- deleted target: skipped
  `);

  const entries = await listShelves(db, 1);
  assert.equal(entries.length, 2);
  const book = entries.find((e) => e.targetType === 'book');
  const adap = entries.find((e) => e.targetType === 'adaptation');
  assert.equal(book.title, 'Dune');
  assert.equal(book.slug, 'dune-frank-herbert');
  assert.equal(adap.title, 'Dune → Dune: Part Two');
  assert.equal(adap.slug, 'dune-part-two-2024');

  // 1 (entries) + 1 (books IN) + 1 (adaptations IN) — flat per shelf size.
  assert.ok(counter.count <= 4, `expected <= 4 prepares, got ${counter.count}`);
});
