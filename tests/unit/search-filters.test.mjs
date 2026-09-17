// tests/unit/search-filters.test.mjs — regression tests for the search
// filter placeholder/bind contract (finding 10, second half).
//
// Run: node --test "tests/unit/*.test.mjs"
//
// The bug: searchStatements() bound every filter value to the screen_works
// query even when its SQL had no matching placeholders (statuses without
// kind) — a hard "column index out of range" at runtime. The fix gives each
// statement its own bind array (src/search_filters.ts). These tests import
// the real module and prove, against real SQLite, that every fragment's
// placeholders pair exactly with its bind array for every filter
// combination.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const { searchFilterFragments } = await import('../../src/search_filters.ts');

/** Highest ?N placeholder referenced in a fragment (0 when none). */
function maxPlaceholder(fragment) {
  let max = 0;
  for (const m of fragment.matchAll(/\?(\d+)/g)) {
    max = Math.max(max, Number(m[1]));
  }
  return max;
}

/** All placeholder numbers referenced, in order of appearance. */
function placeholders(fragment) {
  return [...fragment.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]));
}

/**
 * Prove a fragment + its binds execute: wrap the fragment in a real query
 * against scratch tables and run it with the first five binds standing in
 * for ?1..?5 (the query patterns + limit). SQLite throws "column index out
 * of range" when a bound value has no matching placeholder — exactly the
 * old failure mode.
 */
function executes(filterArgs, which) {
  const f = searchFilterFragments(filterArgs);
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE screen_works (id INTEGER PRIMARY KEY, kind TEXT);
    CREATE TABLE adaptations (id INTEGER PRIMARY KEY, status TEXT);
    INSERT INTO screen_works (kind) VALUES ('film'), ('series');
    INSERT INTO adaptations (status) VALUES ('released'), ('rumored');
  `);
  const baseBinds = ['q', 'q%', '% q%', '%q%', 25]; // ?1..?5
  if (which === 'works') {
    // ?1..?5 are selected so the bind count is always valid; the fragment
    // under test contributes only its own placeholders.
    const rows = db
      .prepare(`SELECT ?1, ?2, ?3, ?4, ?5, id FROM screen_works WHERE 1=1${f.worksFilter}`)
      .all(...baseBinds, ...f.worksBind);
    return rows;
  }
  const rows = db
    .prepare(
      `SELECT ?1, ?2, ?3, ?4, ?5, a.id FROM adaptations a
         JOIN screen_works s ON 1=1
        WHERE 1=1${f.adaptationFilter}`,
    )
    .all(...baseBinds, ...f.adaptationBind);
  return rows;
}

const COMBOS = [
  [{}, 'no filters'],
  [{ statuses: ['released'] }, 'statuses only'],
  [{ statuses: ['released', 'rumored'] }, 'two statuses'],
  [{ kind: 'film' }, 'kind only'],
  [{ statuses: ['released'], kind: 'film' }, 'statuses + kind'],
  [{ statuses: [], kind: '' }, 'empty statuses, blank kind'],
];

for (const [filters, label] of COMBOS) {
  test(`fragments execute against SQLite: ${label}`, () => {
    const f = searchFilterFragments(filters);
    assert.doesNotThrow(() => executes(filters, 'works'));
    assert.doesNotThrow(() => executes(filters, 'adaptations'));

    // Placeholder/bind pairing is exact per statement.
    const worksPh = placeholders(f.worksFilter);
    assert.deepEqual(
      worksPh,
      f.worksBind.map((_, i) => 6 + i),
      `works placeholders must be exactly ?6.. for the ${f.worksBind.length} binds (${label})`,
    );
    const adapPh = placeholders(f.adaptationFilter);
    assert.deepEqual(
      adapPh,
      f.adaptationBind.map((_, i) => 6 + i),
      `adaptation placeholders must be exactly ?6.. for the ${f.adaptationBind.length} binds (${label})`,
    );
  });
}

test('statuses only: works query takes no binds, adaptations takes statuses', () => {
  const f = searchFilterFragments({ statuses: ['released', 'rumored'] });
  assert.equal(f.worksFilter, '');
  assert.deepEqual(f.worksBind, []);
  assert.match(f.adaptationFilter, /a\.status IN \(\?6, \?7\)/);
  assert.deepEqual(f.adaptationBind, ['released', 'rumored']);
});

test('kind only: works takes ?6, adaptations takes ?6', () => {
  const f = searchFilterFragments({ kind: 'series' });
  assert.equal(f.worksFilter, ' AND kind = ?6');
  assert.deepEqual(f.worksBind, ['series']);
  assert.equal(f.adaptationFilter, ' AND s.kind = ?6');
  assert.deepEqual(f.adaptationBind, ['series']);
});

test('statuses + kind: kind shifts past the statuses on adaptations only', () => {
  const f = searchFilterFragments({ statuses: ['released'], kind: 'film' });
  assert.equal(f.worksFilter, ' AND kind = ?6');
  assert.deepEqual(f.worksBind, ['film']);
  assert.match(f.adaptationFilter, /a\.status IN \(\?6\) AND s\.kind = \?7/);
  assert.deepEqual(f.adaptationBind, ['released', 'film']);
});

test('kind filter actually filters rows in SQLite', () => {
  const rows = executes({ kind: 'film' }, 'works');
  assert.equal(rows.length, 1);
});
