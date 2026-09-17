// tests/unit/api.test.mjs — API-level regression tests against the real v1
// router (src/api/v1.ts), mounted on Hono with an in-memory SQLite database
// shaped like D1 and the full migration chain applied.
//
//  - finding 11: GET /api/v1/reviews paginates at the API layer — page 2+
//    must return the SQL page, not an in-memory re-slice (which emptied
//    page 2+ when listReviewsPage already paginated).
//  - finding 9: PUT /lists/:id (edit + public→private) and DELETE /lists/:id
//    purge the cached bot preview via caches.default.delete.
//
// Run: node --test "tests/unit/*.test.mjs"

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { register } from 'node:module';

register(new URL('./hooks/extensionless.mjs', import.meta.url));

const { mountV1 } = await import('../../src/api/v1.ts');

/** D1-shaped adapter over node:sqlite. */
function d1(sqlite) {
  const execBound = (sql, args) => {
    const stmt = sqlite.prepare(sql);
    if (/^\s*(SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(sql)) {
      return { results: stmt.all(...args) };
    }
    const info = stmt.run(...args);
    return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
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
    prepare: (sql) => ({ bind: (...args) => boundStmt(sql, args) }),
    batch: async (stmts) => stmts.map((s) => execBound(s._sql, s._args)),
  };
}

let app, env, sqlite;

const purged = [];
const pendingWaits = [];

before(async () => {
  sqlite = new DatabaseSync(':memory:');
  for (const f of readdirSync('migrations').sort()) {
    sqlite.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }

  const db = d1(sqlite);
  // Admin user + session (na_session cookie = 'test-session-token').
  // Ids are left to autoincrement: the migration chain seeds catalog rows.
  const tokenHash = createHash('sha256').update('test-session-token').digest('hex');
  sqlite.exec(`INSERT INTO users (email, is_admin) VALUES ('admin@example.com', 1);`);
  const userId = sqlite.prepare('SELECT id FROM users WHERE email = ?').get('admin@example.com').id;
  sqlite.exec(
    `INSERT INTO sessions (user_id, token_hash, expires_at)
      VALUES (${userId}, '${tokenHash}', datetime('now', '+30 days'));`,
  );
  sqlite.exec(`INSERT INTO books (title, authors, slug) VALUES ('Test Book', 'Test Author', 'test-book');`);
  const bookId = sqlite.prepare('SELECT id FROM books WHERE slug = ?').get('test-book').id;
  for (let i = 1; i <= 25; i++) {
    sqlite.exec(`INSERT INTO users (email) VALUES ('reviewer${i}@example.com');`);
    const rid = sqlite.prepare('SELECT id FROM users WHERE email = ?').get(`reviewer${i}@example.com`).id;
    sqlite
      .prepare(
        `INSERT INTO reviews (user_id, target_type, target_id, title, body, created_at, updated_at)
         VALUES (?, 'book', ?, ?, ?, '2026-09-01 00:00:00', '2026-09-01 00:00:00')`,
      )
      .run(rid, bookId, `Review ${i}`, `Body ${i}`);
  }
  sqlite.exec(
    `INSERT INTO lists (user_id, title, description, is_public, slug)
      VALUES (${userId}, 'My List', 'desc', 1, 'my-list');`,
  );
  const listId = sqlite.prepare('SELECT id FROM lists WHERE slug = ?').get('my-list').id;
  globalThis.__testIds = { userId, bookId, listId };

  globalThis.caches = {
    default: {
      delete: async (req) => {
        purged.push(req instanceof Request ? req.url : String(req));
        return true;
      },
    },
  };

  app = new Hono();
  mountV1(app);
  env = { DB: db, ENVIRONMENT: 'test' };
});

async function req(path, opts = {}) {
  pendingWaits.length = 0;
  const ctx = {
    waitUntil: (p) => pendingWaits.push(Promise.resolve(p)),
    passThroughOnException: () => {},
  };
  const res = await app.request(
    path,
    { headers: { cookie: 'na_session=test-session-token' }, ...opts },
    env,
    ctx,
  );
  await Promise.all(pendingWaits);
  return res;
}

// --- finding 11: API-level pagination -----------------------------------------

test('GET /api/v1/reviews page 2 returns the SQL page (not an empty re-slice)', async () => {
  const res = await req(`/api/v1/reviews?target_type=book&target_id=${globalThis.__testIds.bookId}&page=2&per_page=10`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.reviews.page, 2);
  assert.equal(body.reviews.per_page, 10);
  assert.equal(body.reviews.total, 25);
  // The old double-pagination bug returned [] here.
  assert.equal(body.reviews.data.length, 10);
  assert.deepEqual(
    body.reviews.data.map((r) => r.title),
    Array.from({ length: 10 }, (_, i) => `Review ${15 - i}`), // newest first
  );
});

test('GET /api/v1/reviews page 3 returns the final partial page', async () => {
  const res = await req(`/api/v1/reviews?target_type=book&target_id=${globalThis.__testIds.bookId}&page=3&per_page=10`);
  const body = await res.json();
  assert.equal(body.reviews.data.length, 5);
  assert.equal(body.reviews.total, 25);
});

// --- finding 9: list-preview purge ---------------------------------------------

test('PUT /api/v1/lists/:id purges the bot preview on edit', async () => {
  purged.length = 0;
  const res = await req(`/api/v1/lists/${globalThis.__testIds.listId}`, {
    method: 'PUT',
    headers: {
      cookie: 'na_session=test-session-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title: 'My List (edited)' }),
  });
  assert.equal(res.status, 200);
  assert.ok(
    purged.some((u) => u === 'http://localhost/lists/my-list?na-prerender=1'),
    `preview purge expected, got: ${JSON.stringify(purged)}`,
  );
});

test('PUT /api/v1/lists/:id purges the bot preview on public→private', async () => {
  purged.length = 0;
  const res = await req(`/api/v1/lists/${globalThis.__testIds.listId}`, {
    method: 'PUT',
    headers: {
      cookie: 'na_session=test-session-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ is_public: false }),
  });
  assert.equal(res.status, 200);
  const row = sqlite.prepare('SELECT is_public FROM lists WHERE id = ' + globalThis.__testIds.listId + '').get();
  assert.equal(row.is_public, 0);
  assert.ok(
    purged.some((u) => u.includes('/lists/my-list?na-prerender=1')),
    `preview purge expected after privatizing, got: ${JSON.stringify(purged)}`,
  );
});

test('DELETE /api/v1/lists/:id purges the bot preview', async () => {
  purged.length = 0;
  const res = await req(`/api/v1/lists/${globalThis.__testIds.listId}`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  assert.ok(
    purged.some((u) => u.includes('/lists/my-list?na-prerender=1')),
    `preview purge expected after delete, got: ${JSON.stringify(purged)}`,
  );
});
