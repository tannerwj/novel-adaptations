// tests/unit/trailers.test.mjs — TMDB /videos trailer picking + fetch outcomes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./hooks/extensionless.mjs', import.meta.url));
const { pickTrailerKey, fetchTrailerKey } = await import('../../src/trailers.ts');

const trailer = (key, extra = {}) => ({
  key,
  site: 'YouTube',
  type: 'Trailer',
  official: true,
  ...extra,
});

test('pickTrailerKey prefers official YouTube trailers', () => {
  const payload = {
    results: [
      trailer('unofficial-clip', { type: 'Clip', official: false }),
      trailer('official', { official: true }),
      trailer('vimeo', { site: 'Vimeo' }),
      { key: '', site: 'YouTube', type: 'Trailer' },
    ],
  };
  assert.equal(pickTrailerKey(payload), 'official');
});

test('pickTrailerKey falls back to any YouTube video', () => {
  const payload = { results: [trailer('teaser', { type: 'Teaser', official: false })] };
  assert.equal(pickTrailerKey(payload), 'teaser');
});

test('pickTrailerKey returns null for garbage payloads', () => {
  assert.equal(pickTrailerKey(null), null);
  assert.equal(pickTrailerKey({}), null);
  assert.equal(pickTrailerKey({ results: 'nope' }), null);
  assert.equal(pickTrailerKey({ results: [{ site: 'Vimeo', key: 'x' }] }), null);
});

const stubFetcher = (json, status = 200) => async () => ({
  ok: status === 200,
  status,
  json: async () => json,
});

test('fetchTrailerKey returns not-attempted without key or id', async () => {
  assert.deepEqual(
    await fetchTrailerKey(123, 'film', '', stubFetcher({})),
    { status: 'not-attempted' },
  );
  assert.deepEqual(
    await fetchTrailerKey(0, 'film', 'k', stubFetcher({})),
    { status: 'not-attempted' },
  );
});

test('fetchTrailerKey returns hit with the picked key', async () => {
  const r = await fetchTrailerKey(
    123,
    'film',
    'k',
    stubFetcher({ results: [trailer('abc123')] }),
  );
  assert.deepEqual(r, { status: 'hit', key: 'abc123' });
});

test('fetchTrailerKey returns no-match when TMDB has nothing playable', async () => {
  assert.deepEqual(
    await fetchTrailerKey(123, 'series', 'k', stubFetcher({ results: [] })),
    { status: 'no-match' },
  );
  // 404 on the videos endpoint also means no trailer (caller caches it).
  assert.deepEqual(
    await fetchTrailerKey(123, 'film', 'k', stubFetcher({}, 404)),
    { status: 'no-match' },
  );
});

test('fetchTrailerKey returns failed on HTTP errors and network throws', async () => {
  const http = await fetchTrailerKey(123, 'film', 'k', stubFetcher({}, 500));
  assert.equal(http.status, 'failed');
  const net = await fetchTrailerKey(123, 'film', 'k', async () => {
    throw new Error('network down');
  });
  assert.equal(net.status, 'failed');
});
