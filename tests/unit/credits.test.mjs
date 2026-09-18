// tests/unit/credits.test.mjs — TMDB credits enrichment (migration 0026):
// extractCredits pure extraction, fetchCreditsById outcomes, parseCastJson,
// and the actor/director JSON-LD nodes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./hooks/extensionless.mjs', import.meta.url));
const { extractCredits, fetchCreditsById } = await import('../../src/tmdb.ts');
const { parseCastJson } = await import('../../src/db.ts');
const { screenWorkJsonLd } = await import('../../src/prerender.ts');

const filmPayload = {
  vote_average: 8.1,
  vote_count: 12345,
  credits: {
    cast: [
      { name: 'Second Star', character: 'Hero', order: 1, profile_path: '/b.jpg' },
      { name: 'Top Star', character: 'Lead', order: 0, profile_path: '/a.jpg' },
      { name: 'No Photo', character: 'Extra', order: 2, profile_path: null },
      { name: '', character: 'Ghost', order: 3, profile_path: '/c.jpg' },
    ],
    crew: [
      { name: 'Jane Director', job: 'Director' },
      { name: 'John Writer', job: 'Writer' },
    ],
  },
};

test('extractCredits sorts cast by billing order and caps at 8', () => {
  const c = extractCredits('film', filmPayload);
  assert.equal(c.cast.length, 3); // the empty-name entry is dropped
  assert.equal(c.cast[0].name, 'Top Star');
  assert.equal(c.cast[0].profile_path, '/a.jpg');
  assert.equal(c.cast[2].name, 'No Photo');
  assert.equal(c.cast[2].profile_path, null);
});

test('extractCredits pulls director for films and ratings', () => {
  const c = extractCredits('film', filmPayload);
  assert.equal(c.director, 'Jane Director');
  assert.equal(c.creators, null);
  assert.equal(c.vote_average, 8.1);
  assert.equal(c.vote_count, 12345);
});

test('extractCredits pulls creators (not director) for series', () => {
  const c = extractCredits('series', {
    vote_average: 7.5,
    vote_count: 100,
    created_by: [{ name: 'Show Runner' }, { name: 'Co Creator' }],
    credits: { cast: [], crew: [{ name: 'Jane Director', job: 'Director' }] },
  });
  assert.equal(c.creators, 'Show Runner, Co Creator');
  assert.equal(c.director, null);
});

test('extractCredits is defensive against garbage payloads', () => {
  const c = extractCredits('film', { credits: { cast: 'nope', crew: null } });
  assert.deepEqual(c.cast, []);
  assert.equal(c.director, null);
  assert.equal(c.vote_average, null);
  const n = extractCredits('film', null);
  assert.deepEqual(n.cast, []);
});

test('fetchCreditsById maps outcomes: hit / 404 no-match / 500 failed / no key', async () => {
  const resp = (status, body) => async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  const hit = await fetchCreditsById('KEY', 'film', 693134, resp(200, filmPayload));
  assert.equal(hit.status, 'hit');
  assert.equal(hit.credits.cast[0].name, 'Top Star');

  const nf = await fetchCreditsById('KEY', 'film', 1, resp(404, null));
  assert.equal(nf.status, 'no-match');

  const fail = await fetchCreditsById('KEY', 'film', 1, resp(500, null));
  assert.equal(fail.status, 'failed');

  const noKey = await fetchCreditsById('', 'film', 1, resp(200, filmPayload));
  assert.equal(noKey.status, 'not-attempted');

  const throws = await fetchCreditsById('KEY', 'film', 1, async () => { throw new Error('boom'); });
  assert.equal(throws.status, 'failed');
});

test('parseCastJson round-trips and rejects garbage', () => {
  const raw = JSON.stringify([
    { name: 'A Star', character: 'Lead', profile_path: '/a.jpg' },
    { name: 'B Star', character: '', profile_path: null },
  ]);
  const parsed = parseCastJson(raw);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].character, 'Lead');
  assert.deepEqual(parseCastJson(null), []);
  assert.deepEqual(parseCastJson('not json'), []);
  assert.deepEqual(parseCastJson('{"a":1}'), []);
});

test('screenWorkJsonLd emits actor and director Person nodes', () => {
  const base = {
    title: 'Dune: Part Two',
    kind: 'film',
    releaseDate: '2024-03-01',
    description: 'd',
    canonical: 'https://noveladaptations.com/watch/dune-part-two-2024',
    image: 'https://noveladaptations.com/og.png',
    books: [],
  };
  const withCast = screenWorkJsonLd({ ...base, cast: ['Timothée Chalamet', 'Zendaya'], director: 'Denis Villeneuve' });
  assert.deepEqual(withCast.actor, [
    { '@type': 'Person', name: 'Timothée Chalamet' },
    { '@type': 'Person', name: 'Zendaya' },
  ]);
  assert.deepEqual(withCast.director, { '@type': 'Person', name: 'Denis Villeneuve' });

  const bare = screenWorkJsonLd(base);
  assert.ok(!('actor' in bare));
  assert.ok(!('director' in bare));
});
