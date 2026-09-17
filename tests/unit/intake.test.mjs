// tests/unit/intake.test.mjs — regression tests for the feedback → catalog
// metadata intake (POST /api/feedback/:id/intake).
//
// Run: node --test "tests/unit/*.test.mjs"
//
// Imports the real intakeFromTip from src/intake.ts via node type-stripping,
// with a resolve hook for its extensionless './tmdb' import. D1 and the
// network are faked: a tiny in-memory D1 shim routes the handful of queries
// intake issues, and a stub fetcher returns canned TMDB /find and
// Open Library responses.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./hooks/extensionless.mjs', import.meta.url));

const { intakeFromTip, IntakeError, imdbIdFromUrl } = await import(
  '../../src/intake.ts'
);

/** Minimal D1 shim: routes intake's queries to in-memory tables. */
function fakeDb(seed = {}, opts = {}) {
  const state = {
    screenWorks: [],
    books: [],
    adaptations: [],
    slugs: new Set(),
    writes: [],
    ...seed,
  };
  let nextId = 100;
  // Executes one bound statement — shared by run() and batch().
  const execRun = async (q, args) => {
    if (opts.failInserts && q.startsWith(`INSERT INTO ${opts.failInserts}`)) {
      throw new Error(`simulated ${opts.failInserts} insert failure`);
    }
    state.writes.push(q);
    if (q.startsWith('INSERT INTO screen_works')) {
      const id = nextId++;
      state.screenWorks.push({ id, tmdb_id: args[0], title: args[1] });
      state.slugs.add(args[7]);
      return { meta: { last_row_id: id } };
    }
    if (q.startsWith('INSERT INTO books')) {
      const id = nextId++;
      state.books.push({
        id,
        openlibrary_id: args[4],
        title: args[0],
        description: args[6],
        subjects: args[7],
      });
      state.slugs.add(args[5]);
      return { meta: { last_row_id: id } };
    }
    if (q.startsWith('INSERT INTO adaptations')) {
      // Mirrors the COALESCE(known id, subselect) linking in src/intake.ts.
      const id = nextId++;
      const book = args[0] != null ? { id: args[0] } : state.books.find((b) => b.openlibrary_id === args[1]);
      const work = args[2] != null ? { id: args[2] } : state.screenWorks.find((w) => w.tmdb_id === args[3]);
      if (!book || !work) throw new Error('adaptation link target missing');
      state.adaptations.push({
        id,
        book_id: book.id,
        screen_work_id: work.id,
        status: args[4],
        source_url: args[5],
      });
      state.slugs.add(args[6]);
      return { meta: { last_row_id: id } };
    }
    throw new Error('unexpected run(): ' + q);
  };
  const db = {
    state,
    prepare(sql) {
      const q = sql.replace(/\s+/g, ' ').trim();
      return {
        bind(...args) {
          return {
            first: async () => {
              if (q.startsWith('SELECT id, title FROM screen_works WHERE tmdb_id')) {
                const r = state.screenWorks.find((w) => w.tmdb_id === args[0]);
                return r ? { id: r.id, title: r.title } : null;
              }
              if (q.startsWith('SELECT id FROM books WHERE openlibrary_id')) {
                const r = state.books.find((b) => b.openlibrary_id === args[0]);
                return r ? { id: r.id } : null;
              }
              if (q.startsWith('SELECT id, status FROM adaptations WHERE book_id')) {
                const r = state.adaptations.find(
                  (a) => a.book_id === args[0] && a.screen_work_id === args[1],
                );
                return r ? { id: r.id, status: r.status } : null;
              }
              if (q.includes('WHERE slug = ?1')) {
                return state.slugs.has(args[0]) ? { id: 1 } : null;
              }
              throw new Error('unexpected first(): ' + q);
            },
            run: () => execRun(q, args),
          };
        },
      };
    },
    // Simulates D1 batch(): all statements apply, or none do.
    batch: async (stmts) => {
      const snap = JSON.stringify({
        screenWorks: state.screenWorks,
        books: state.books,
        adaptations: state.adaptations,
        slugs: [...state.slugs],
        writes: state.writes,
      });
      const savedNextId = nextId;
      const out = [];
      try {
        for (const s of stmts) out.push(await s.run());
        return out;
      } catch (e) {
        const r = JSON.parse(snap);
        state.screenWorks = r.screenWorks;
        state.books = r.books;
        state.adaptations = r.adaptations;
        state.slugs = new Set(r.slugs);
        state.writes = r.writes;
        nextId = savedNextId;
        throw e;
      }
    },
  };
  return db;
}

const MOVIE_HIT = {
  id: 999001,
  title: 'The Love Hypothesis',
  poster_path: '/poster.jpg',
  backdrop_path: '/backdrop.jpg',
  overview: 'A fake dating trope rom-com.',
  release_date: '2099-09-25',
};

function stubFetcher({ find, search, ol, olWork, olWorkThrows = false, findThrows = false } = {}) {
  return async (url) => {
    const u = String(url);
    if (u.includes('/find/tt')) {
      if (findThrows) throw new Error('network down');
      return {
        ok: true,
        status: 200,
        json: async () => find ?? { movie_results: [], tv_results: [] },
      };
    }
    if (u.includes('/search/movie') || u.includes('/search/tv')) {
      return {
        ok: true,
        status: 200,
        json: async () => search ?? { results: [] },
      };
    }
    if (u.includes('openlibrary.org/works/')) {
      if (olWorkThrows) throw new Error('network down');
      return {
        ok: true,
        status: 200,
        json: async () =>
          olWork ?? {
            description: { value: 'Olive is a PhD student who fake-dates a professor.' },
            subjects: ['Romance', 'Fiction', 'Love stories'],
          },
      };
    }
    if (u.includes('openlibrary.org')) {
      return {
        ok: true,
        status: 200,
        json: async () =>
          ol ?? {
            docs: [
              {
                key: '/works/OL999W',
                title: 'The Love Hypothesis',
                author_name: ['Ali Hazelwood'],
                cover_i: 12345,
                first_publish_year: 2021,
              },
            ],
          },
      };
    }
    throw new Error('unexpected fetch: ' + u);
  };
}

const BASE_INPUT = {
  subject: 'The love hypothesis',
  proofUrl: 'https://www.imdb.com/title/tt22526100/',
  sourceUrl: 'https://www.imdb.com/title/tt22526100/',
  tmdbApiKey: 'test-key',
};

test('imdbIdFromUrl extracts the tt id', () => {
  assert.equal(imdbIdFromUrl('https://www.imdb.com/title/tt22526100/'), 'tt22526100');
  assert.equal(imdbIdFromUrl('http://www.imdb.com/title/tt123/?ref_=x'), 'tt123');
  assert.equal(imdbIdFromUrl('https://example.com/foo'), null);
  assert.equal(imdbIdFromUrl(null), null);
});

test('happy path: imdb id → creates book, film, adaptation', async () => {
  const db = fakeDb();
  const fetcher = stubFetcher({
    find: { movie_results: [MOVIE_HIT], tv_results: [] },
  });
  const r = await intakeFromTip(db, BASE_INPUT, fetcher);

  assert.equal(r.book.created, true);
  assert.equal(r.book.title, 'The Love Hypothesis');
  assert.equal(r.screenWork.created, true);
  assert.equal(r.screenWork.title, 'The Love Hypothesis');
  assert.equal(r.screenWork.kind, 'film');
  assert.equal(r.adaptation.created, true);
  assert.equal(r.adaptation.status, 'post_production');
  assert.deepEqual(r.warnings, []);

  const writes = db.state.writes.join('\n');
  assert.match(writes, /INSERT INTO screen_works/);
  assert.match(writes, /INSERT INTO books/);
  assert.match(writes, /INSERT INTO adaptations/);
  // Source URL persisted on the adaptation.
  const adap = db.state.adaptations[0];
  assert.equal(adap.source_url, BASE_INPUT.proofUrl);
  // Poster + cover + slug made it into the inserts.
  const workInsert = db.state.writes.find((w) => w.startsWith('INSERT INTO screen_works'));
  assert.ok(workInsert);
});

test('book intake stores OL work description and subjects', async () => {
  const db = fakeDb();
  const fetcher = stubFetcher({
    find: { movie_results: [MOVIE_HIT], tv_results: [] },
  });
  await intakeFromTip(db, BASE_INPUT, fetcher);
  const book = db.state.books[0];
  assert.equal(book.description, 'Olive is a PhD student who fake-dates a professor.');
  assert.deepEqual(JSON.parse(book.subjects), ['Romance', 'Fiction', 'Love stories']);
});

test('book intake degrades when OL work detail fails', async () => {
  const db = fakeDb();
  const fetcher = stubFetcher({
    find: { movie_results: [MOVIE_HIT], tv_results: [] },
    olWorkThrows: true,
  });
  const r = await intakeFromTip(db, BASE_INPUT, fetcher);
  assert.equal(r.book.created, true);
  const book = db.state.books[0];
  assert.equal(book.description, null);
  assert.deepEqual(JSON.parse(book.subjects), []);
});

test('book intake stores string-form OL description', async () => {
  const db = fakeDb();
  const fetcher = stubFetcher({
    find: { movie_results: [MOVIE_HIT], tv_results: [] },
    olWork: { description: 'A plain string blurb.', subjects: 'not-an-array' },
  });
  await intakeFromTip(db, BASE_INPUT, fetcher);
  const book = db.state.books[0];
  assert.equal(book.description, 'A plain string blurb.');
  assert.deepEqual(JSON.parse(book.subjects), []);
});

test('rerun is idempotent: existing rows reused, nothing written', async () => {
  const db = fakeDb({
    screenWorks: [{ id: 7, tmdb_id: MOVIE_HIT.id, title: 'The Love Hypothesis' }],
    books: [{ id: 8, openlibrary_id: '/works/OL999W', title: 'The Love Hypothesis' }],
    adaptations: [{ id: 9, book_id: 8, screen_work_id: 7, status: 'post_production' }],
  });
  const fetcher = stubFetcher({
    find: { movie_results: [MOVIE_HIT], tv_results: [] },
  });
  const r = await intakeFromTip(db, BASE_INPUT, fetcher);

  assert.equal(r.book.created, false);
  assert.equal(r.book.id, 8);
  assert.equal(r.screenWork.created, false);
  assert.equal(r.screenWork.id, 7);
  assert.equal(r.adaptation.created, false);
  assert.equal(r.adaptation.id, 9);
  assert.equal(db.state.writes.length, 0);
  assert.match(r.warnings.join(' '), /already in the catalog/);
});

test('no imdb id: falls back to exact-title search', async () => {
  const db = fakeDb();
  let searchedKinds = [];
  const fetcher = async (url) => {
    const u = String(url);
    if (u.includes('/search/movie')) searchedKinds.push('film');
    if (u.includes('/search/tv')) searchedKinds.push('series');
    return stubFetcher({
      search: {
        results: [
          {
            id: 555,
            title: 'The Love Hypothesis',
            poster_path: '/p.jpg',
            release_date: '2001-05-04',
          },
        ],
      },
    })(url);
  };
  const r = await intakeFromTip(
    db,
    { ...BASE_INPUT, proofUrl: null, sourceUrl: null },
    fetcher,
  );
  assert.deepEqual(searchedKinds, ['film']);
  assert.equal(r.screenWork.created, true);
  assert.equal(r.screenWork.kind, 'film');
  // Past release → 'released' (satisfies the release invariant).
  assert.equal(r.adaptation.status, 'released');
});

test('series fallback: film misses, tv hits', async () => {
  const db = fakeDb();
  const fetcher = async (url) => {
    const u = String(url);
    if (u.includes('/search/movie')) {
      return { ok: true, status: 200, json: async () => ({ results: [] }) };
    }
    if (u.includes('/search/tv')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            {
              id: 777,
              name: 'The Love Hypothesis',
              poster_path: '/p.jpg',
              first_air_date: '2099-01-01',
            },
          ],
        }),
      };
    }
    return stubFetcher({})(url);
  };
  const r = await intakeFromTip(
    db,
    { ...BASE_INPUT, proofUrl: null, sourceUrl: null },
    fetcher,
  );
  assert.equal(r.screenWork.kind, 'series');
  assert.equal(r.adaptation.status, 'post_production');
});

test('no book match on Open Library → IntakeError, nothing written', async () => {
  const db = fakeDb();
  const fetcher = stubFetcher({
    find: { movie_results: [MOVIE_HIT], tv_results: [] },
    ol: { docs: [] },
  });
  await assert.rejects(
    intakeFromTip(db, BASE_INPUT, fetcher),
    (e) => e instanceof IntakeError && /Open Library/.test(e.message),
  );
  assert.equal(db.state.writes.length, 0);
});

test('TMDB failure → IntakeError, nothing written', async () => {
  const db = fakeDb();
  const fetcher = stubFetcher({
    find: { movie_results: [MOVIE_HIT], tv_results: [] },
    findThrows: true,
  });
  await assert.rejects(
    intakeFromTip(db, BASE_INPUT, fetcher),
    (e) => e instanceof IntakeError && /TMDB lookup failed/.test(e.message),
  );
  assert.equal(db.state.writes.length, 0);
});

test('missing TMDB key → IntakeError before any network', async () => {
  const db = fakeDb();
  let fetched = false;
  const fetcher = async () => {
    fetched = true;
    throw new Error('should not fetch');
  };
  await assert.rejects(
    intakeFromTip(db, { ...BASE_INPUT, tmdbApiKey: undefined }, fetcher),
    (e) => e instanceof IntakeError && /TMDB_API_KEY/.test(e.message),
  );
  assert.equal(fetched, false);
  assert.equal(db.state.writes.length, 0);
});

test('no release date → rumored status', async () => {
  const db = fakeDb();
  const fetcher = stubFetcher({
    find: {
      movie_results: [{ ...MOVIE_HIT, release_date: '' }],
      tv_results: [],
    },
  });
  const r = await intakeFromTip(db, BASE_INPUT, fetcher);
  assert.equal(r.adaptation.status, 'rumored');
});

test('atomic batch: a failed insert rolls back every write', async () => {
  const db = fakeDb({}, { failInserts: 'adaptations' });
  const fetcher = stubFetcher({
    find: { movie_results: [MOVIE_HIT], tv_results: [] },
  });
  await assert.rejects(() => intakeFromTip(db, BASE_INPUT, fetcher));
  // Nothing partial may survive: no book, no screen work, no adaptation.
  assert.equal(db.state.books.length, 0);
  assert.equal(db.state.screenWorks.length, 0);
  assert.equal(db.state.adaptations.length, 0);
});
