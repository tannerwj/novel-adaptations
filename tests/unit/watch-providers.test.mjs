// tests/unit/watch-providers.test.mjs — regression tests for finding 14.
//
// The bugs being guarded:
//  - A successful TMDB response with no US providers used to be treated as
//    a failure: nothing was cached, so every view refetched forever.
//  - A background refresh of a stale row that succeeded-empty left the stale
//    providers in place; a refresh that failed must still preserve them.
//
// fetchWatchProvidersDetailed takes an injectable fetcher, but
// getWatchProviders/refreshCache use the default (global fetch), so the
// tests stub globalThis.fetch and restore it afterwards.
//
// Run: node --test "tests/unit/*.test.mjs"

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { register } from 'node:module';

register(new URL('./hooks/extensionless.mjs', import.meta.url));

// The pure logic lives in watch_providers_cache.ts (no JSX) so node can
// type-strip it; the .tsx shell re-exports it for the worker.
const { getWatchProviders, fetchAndCacheProviders } = await import(
  '../../src/watch_providers_cache.ts'
);

const realFetch = globalThis.fetch;

function stubFetch(handler) {
  globalThis.fetch = handler;
}
function restoreFetch() {
  globalThis.fetch = realFetch;
}
const okEmpty = () => ({
  ok: true,
  status: 200,
  json: async () => ({ results: {} }), // TMDB answered; no US region at all
});
const okWithProviders = () => ({
  ok: true,
  status: 200,
  json: async () => ({
    results: {
      US: {
        flatrate: [
          { provider_id: 8, provider_name: 'Netflix', logo_path: '/n.png' },
        ],
        link: 'https://www.themoviedb.org/movie/1/watch?locale=US',
      },
    },
  }),
});
const failing = () => {
  throw new Error('network down');
};

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
    CREATE TABLE watch_provider_cache (
      screen_work_id INTEGER PRIMARY KEY,
      providers_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return sqlite;
}

/** waitUntil collector: lets tests await the background refresh. */
function testCtx() {
  const pending = [];
  return {
    ctx: { waitUntil: (p) => pending.push(p) },
    drain: () => Promise.all(pending),
  };
}

const EMPTY = { flatrate: [], rent: [], buy: [], link: null };
const work = (id, tmdb_id = 1000 + id) => ({ id, tmdb_id, kind: 'film' });

test('cold miss + successful empty TMDB response writes a negative cache entry', async () => {
  const sqlite = seed();
  const db = d1(sqlite);
  stubFetch(okEmpty);
  try {
    const data = await getWatchProviders(db, testCtx().ctx, { TMDB_API_KEY: 'k' }, work(1));
    assert.deepEqual(data, EMPTY);
    const row = sqlite
      .prepare('SELECT providers_json FROM watch_provider_cache WHERE screen_work_id = 1')
      .get();
    assert.ok(row, 'negative entry should be cached');
    assert.deepEqual(JSON.parse(row.providers_json), EMPTY);
  } finally {
    restoreFetch();
  }
});

test('cold miss + TMDB failure writes nothing and returns null', async () => {
  const sqlite = seed();
  const db = d1(sqlite);
  stubFetch(failing);
  try {
    const data = await getWatchProviders(db, testCtx().ctx, { TMDB_API_KEY: 'k' }, work(1));
    assert.equal(data, null);
    const row = sqlite
      .prepare('SELECT COUNT(*) AS n FROM watch_provider_cache')
      .get();
    assert.equal(row.n, 0);
  } finally {
    restoreFetch();
  }
});

test('stale cache is served immediately and refreshed in the background', async () => {
  const sqlite = seed();
  const db = d1(sqlite);
  const stalePayload = { flatrate: [{ id: 8, name: 'Netflix', logo: 'x' }], rent: [], buy: [], link: null };
  sqlite
    .prepare(
      `INSERT INTO watch_provider_cache (screen_work_id, providers_json, updated_at)
       VALUES (1, ?, datetime('now', '-8 days'))`,
    )
    .run(JSON.stringify(stalePayload));
  stubFetch(okWithProviders);
  const t = testCtx();
  try {
    const data = await getWatchProviders(db, t.ctx, { TMDB_API_KEY: 'k' }, work(1));
    assert.deepEqual(data, stalePayload); // stale served now…
    await t.drain(); // …background refresh completes
    const row = sqlite
      .prepare('SELECT providers_json FROM watch_provider_cache WHERE screen_work_id = 1')
      .get();
    const cached = JSON.parse(row.providers_json);
    assert.equal(cached.flatrate[0].name, 'Netflix');
    assert.equal(cached.flatrate[0].id, 8);
  } finally {
    restoreFetch();
  }
});

test('background refresh that succeeds empty replaces stale providers', async () => {
  const sqlite = seed();
  const db = d1(sqlite);
  const stalePayload = { flatrate: [{ id: 8, name: 'Netflix', logo: 'x' }], rent: [], buy: [], link: null };
  sqlite
    .prepare(
      `INSERT INTO watch_provider_cache (screen_work_id, providers_json, updated_at)
       VALUES (1, ?, datetime('now', '-8 days'))`,
    )
    .run(JSON.stringify(stalePayload));
  stubFetch(okEmpty); // TMDB now reports no US availability
  const t = testCtx();
  try {
    const data = await getWatchProviders(db, t.ctx, { TMDB_API_KEY: 'k' }, work(1));
    assert.deepEqual(data, stalePayload);
    await t.drain();
    const row = sqlite
      .prepare('SELECT providers_json FROM watch_provider_cache WHERE screen_work_id = 1')
      .get();
    assert.deepEqual(JSON.parse(row.providers_json), EMPTY);
  } finally {
    restoreFetch();
  }
});

test('background refresh that fails preserves the stale row', async () => {
  const sqlite = seed();
  const db = d1(sqlite);
  const stalePayload = { flatrate: [{ id: 8, name: 'Netflix', logo: 'x' }], rent: [], buy: [], link: null };
  sqlite
    .prepare(
      `INSERT INTO watch_provider_cache (screen_work_id, providers_json, updated_at)
       VALUES (1, ?, datetime('now', '-8 days'))`,
    )
    .run(JSON.stringify(stalePayload));
  stubFetch(failing);
  const t = testCtx();
  try {
    const data = await getWatchProviders(db, t.ctx, { TMDB_API_KEY: 'k' }, work(1));
    assert.deepEqual(data, stalePayload);
    await t.drain();
    const row = sqlite
      .prepare('SELECT providers_json, updated_at FROM watch_provider_cache WHERE screen_work_id = 1')
      .get();
    assert.deepEqual(JSON.parse(row.providers_json), stalePayload);
  } finally {
    restoreFetch();
  }
});

test('fetchAndCacheProviders converges no-data titles with a negative entry', async () => {
  const sqlite = seed();
  const db = d1(sqlite);
  stubFetch(okEmpty);
  try {
    assert.equal(await fetchAndCacheProviders(db, 'k', 7, 1007, 'film'), true);
    const row = sqlite
      .prepare('SELECT providers_json FROM watch_provider_cache WHERE screen_work_id = 7')
      .get();
    assert.deepEqual(JSON.parse(row.providers_json), EMPTY);
  } finally {
    restoreFetch();
  }
});
