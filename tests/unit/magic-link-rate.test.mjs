// tests/unit/magic-link-rate.test.mjs — regression tests for the magic-link
// sending budgets (finding 7).
//
// Run: node --test "tests/unit/*.test.mjs"
//
// Imports the real checkMagicLinkRate from src/auth/rate_limit.ts via node
// type-stripping. A thin D1 shim runs the real SQL (including migration
// 0023) against in-memory SQLite, so the atomic claim-ticket budgets are
// tested for real: per-email 5/hour, per-IP 20/hour, global 500/hour.
//
// The key property under test: check-and-claim is a SINGLE statement, so
// concurrent requests cannot interleave a read between another request's
// check and increment. The concurrency tests below fire bursts of parallel
// calls and verify the persisted claim counts never exceed any cap.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const { checkMagicLinkRate } = await import('../../src/auth/rate_limit.ts');

/** In-memory SQLite with the real claims table, behind a D1 façade. */
function testDb() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(
    readFileSync(new URL('../../migrations/0023_magic_link_budgets.sql', import.meta.url), 'utf8'),
  );
  return {
    sqlite,
    prepare(sql) {
      const stmt = sqlite.prepare(sql);
      return {
        bind: (...args) => ({
          run: async () => {
            const info = stmt.run(...args);
            return { success: true, meta: { changes: Number(info.changes) } };
          },
          all: async () => ({ success: true, results: stmt.all(...args) }),
        }),
      };
    },
  };
}

function countClaims(db, where = '1 = 1', ...args) {
  return db.sqlite.prepare(`SELECT COUNT(*) AS c FROM magic_link_claims WHERE ${where}`).get(...args).c;
}

test('per-email budget: 5/hour allowed, 6th denied', async () => {
  const db = testDb();
  for (let i = 0; i < 5; i++) {
    assert.equal(await checkMagicLinkRate(db, 'a@example.com', '1.1.1.1'), true);
  }
  assert.equal(await checkMagicLinkRate(db, 'a@example.com', '1.1.1.1'), false);
  // A different email from the same IP is unaffected by the email budget.
  assert.equal(await checkMagicLinkRate(db, 'b@example.com', '1.1.1.1'), true);
});

test('per-IP budget: 20/hour per source, 21st denied even for fresh emails', async () => {
  const db = testDb();
  for (let i = 0; i < 20; i++) {
    assert.equal(
      await checkMagicLinkRate(db, `user${i}@example.com`, '2.2.2.2'),
      true,
      `send ${i + 1} should be allowed`,
    );
  }
  assert.equal(await checkMagicLinkRate(db, 'fresh@example.com', '2.2.2.2'), false);
  // A different source IP is unaffected.
  assert.equal(await checkMagicLinkRate(db, 'fresh@example.com', '3.3.3.3'), true);
});

test('global budget: 500/hour site-wide, 501st denied', async () => {
  const db = testDb();
  for (let i = 0; i < 500; i++) {
    const ok = await checkMagicLinkRate(db, `g${i}@example.com`, `10.0.0.${i % 250}`);
    assert.equal(ok, true, `send ${i + 1} should be allowed`);
  }
  assert.equal(await checkMagicLinkRate(db, 'over@example.com', '9.9.9.9'), false);
});

test('denied calls write nothing at any tier', async () => {
  const db = testDb();
  const hour = new Date().toISOString().slice(0, 13);
  for (let i = 0; i < 5; i++) {
    await checkMagicLinkRate(db, 'c@example.com', '4.4.4.4');
  }
  // 6th and 7th denied at the email tier…
  assert.equal(await checkMagicLinkRate(db, 'c@example.com', '4.4.4.4'), false);
  assert.equal(await checkMagicLinkRate(db, 'c@example.com', '4.4.4.4'), false);
  // …and no tier's persisted count moved: the single statement inserts
  // nothing when any guard fails.
  assert.equal(countClaims(db, 'email = ?', 'c@example.com'), 5);
  assert.equal(countClaims(db, 'hour = ? AND ip = ?', hour, '4.4.4.4'), 5);
  assert.equal(countClaims(db, 'hour = ?', hour), 5);

  // A denial at the IP tier likewise consumes nothing globally.
  const db2 = testDb();
  for (let i = 0; i < 20; i++) {
    await checkMagicLinkRate(db2, `ip${i}@example.com`, '6.6.6.6');
  }
  assert.equal(await checkMagicLinkRate(db2, 'fresh@example.com', '6.6.6.6'), false);
  assert.equal(countClaims(db2), 20);
  // …and the email tier of the denied address is untouched.
  assert.equal(countClaims(db2, 'email = ?', 'fresh@example.com'), 0);
});

test('concurrent burst at the email tier: exactly 5 allowed, counts stay at cap', async () => {
  const db = testDb();
  const hour = new Date().toISOString().slice(0, 13);
  // 20 parallel sends for one address — the old check-then-increment design
  // could let several slip past the cap between another request's read and
  // increment. The single-statement claim serializes them.
  const results = await Promise.all(
    Array.from({ length: 20 }, () => checkMagicLinkRate(db, 'race@example.com', '7.7.7.7')),
  );
  assert.equal(results.filter(Boolean).length, 5);
  assert.equal(countClaims(db, 'email = ?', 'race@example.com'), 5);
  assert.equal(countClaims(db, 'hour = ? AND ip = ?', hour, '7.7.7.7'), 5);
  assert.equal(countClaims(db, 'hour = ?', hour), 5);
});

test('concurrent burst at the IP tier: exactly 20 allowed across fresh emails', async () => {
  const db = testDb();
  const hour = new Date().toISOString().slice(0, 13);
  const results = await Promise.all(
    Array.from({ length: 40 }, (_, i) => checkMagicLinkRate(db, `burst${i}@example.com`, '8.8.8.8')),
  );
  assert.equal(results.filter(Boolean).length, 20);
  assert.equal(countClaims(db, 'hour = ? AND ip = ?', hour, '8.8.8.8'), 20);
  assert.equal(countClaims(db, 'hour = ?', hour), 20);
});

test('hour buckets roll over: a new hour starts fresh', async () => {
  const db = testDb();
  // Fill this hour's email budget, then confirm the claim row is pruned once
  // the clock moves on (best-effort prune keeps the table to ~one hour).
  for (let i = 0; i < 5; i++) {
    await checkMagicLinkRate(db, 'roll@example.com', '9.9.9.9');
  }
  assert.equal(countClaims(db), 5);
  // Simulate the next hour by backdating the claims, then one more send
  // prunes them (lexicographic hour comparison).
  db.sqlite.exec(`UPDATE magic_link_claims SET hour = '2000-01-01T00'`);
  assert.equal(await checkMagicLinkRate(db, 'roll@example.com', '9.9.9.9'), true);
  assert.equal(countClaims(db), 1);
});
