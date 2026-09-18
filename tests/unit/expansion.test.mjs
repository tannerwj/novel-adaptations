// tests/unit/expansion.test.mjs — Wikipedia expansion pipeline.
//
// Run: node --test "tests/unit/*.test.mjs"
//
// Imports the real src/expansion.ts via node type-stripping with a resolve
// hook for its extensionless imports. The network and D1 are faked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./hooks/extensionless.mjs', import.meta.url));

const {
  parseWikiLists,
  parseBookCell,
  parseFilmCell,
  cellText,
  authorMatches,
  splitAuthors,
  scrapeAndStoreExpansionCandidates,
  processExpansionBatch,
  expansionStats,
  countPendingExpansion,
} = await import('../../src/expansion.ts');

/* ------------------------------------------------------------------ */
/* Fixtures: real Wikipedia row content, rewrapped as wikitable HTML.  */
/* ------------------------------------------------------------------ */

const LIST_HTML = `
<table class="wikitable">
<tbody>
<tr><th>Fiction work(s)</th><th>Film adaptation(s)</th></tr>
<tr><td><i>The 25th Hour</i> (2001), David Benioff</td><td><i>25th Hour</i> (2002)</td></tr>
<tr><td><i>3 Assassins</i> (グラスホッパー, <i>Gurasuhoppā</i>) (2004), Kōtarō Isaka</td><td><i>Grasshopper</i> (2015)</td></tr>
<tr><td><i>She: A History of Adventure</i> (serialised 1886–87, published as a book, 1887), H. Rider Haggard</td><td><i>She</i> (1908)</td></tr>
<tr><td></td><td><i>She</i> (1911)</td></tr>
<tr><td><i>The Secret Dreamworld of a Shopaholic</i> (2003), Madeline Wickham (as Sophie Kinsella)</td><td><i>Confessions of a Shopaholic</i> (2009)</td></tr>
<tr><td><i>4.50 from Paddington</i> (1957), Agatha Christie</td><td><i>Murder, She Said</i> (1961)</td></tr>
<tr><td><i>Authorless Book</i> (2001)</td><td><i>Some Film</i> (2002)</td></tr>
</tbody>
</table>`;

const PAGES = [{ sourceList: 'novels-0-9-a-c', sourceUrl: 'https://en.wikipedia.org/wiki/X', html: LIST_HTML }];

test('parseWikiLists extracts candidates from wikitable rows', () => {
  const { candidates, dropped } = parseWikiLists(PAGES);
  assert.equal(dropped, 1); // the authorless row
  assert.equal(candidates.length, 6);

  const c0 = candidates[0];
  assert.equal(c0.bookTitle, 'The 25th Hour');
  assert.equal(c0.bookYear, 2001);
  assert.equal(c0.authors, 'David Benioff');
  assert.equal(c0.filmTitle, '25th Hour');
  assert.equal(c0.filmYear, 2002);
});

test('parseWikiLists strips alt-language parens and prefers the published year', () => {
  const { candidates } = parseWikiLists(PAGES);
  const assassins = candidates[1];
  assert.equal(assassins.bookTitle, '3 Assassins');
  assert.equal(assassins.bookYear, 2004);
  assert.equal(assassins.authors, 'Kōtarō Isaka');

  const she = candidates[2];
  assert.equal(she.bookTitle, 'She: A History of Adventure');
  assert.equal(she.bookYear, 1887); // "published as a book, 1887", not 1886
});

test('parseWikiLists attaches continuation rows to the previous book', () => {
  const { candidates } = parseWikiLists(PAGES);
  const cont = candidates[3];
  assert.equal(cont.bookTitle, 'She: A History of Adventure');
  assert.equal(cont.filmTitle, 'She');
  assert.equal(cont.filmYear, 1911);
});

test('parseWikiLists keeps (as …) aliases as author evidence', () => {
  const { candidates } = parseWikiLists(PAGES);
  const shop = candidates[4];
  assert.match(shop.authors, /Madeline Wickham/);
  assert.match(shop.authors, /Sophie Kinsella/);
});

test('parseBookCell rejects cells without title+author', () => {
  assert.equal(parseBookCell('Authorless Book (2001)'), null);
  assert.equal(parseBookCell(''), null);
  assert.equal(parseBookCell('Just some text, no year'), null);
});

test('parseFilmCell handles missing years', () => {
  assert.deepEqual(parseFilmCell('Camille (1936)'), { title: 'Camille', year: 1936 });
  const noYear = parseFilmCell('Mystery Film');
  assert.equal(noYear.title, 'Mystery Film');
  assert.equal(noYear.year, null);
  assert.equal(parseFilmCell(''), null);
});

test('cellText strips tags and decodes entities', () => {
  assert.equal(cellText('<i>Fish &amp; Chips</i> (1999), A&nbsp;B'), 'Fish & Chips (1999), A B');
});

test('authorMatches implements the subset rule', () => {
  assert.equal(authorMatches('Herbert, Frank', ['Frank Herbert']), true);
  assert.equal(authorMatches('Stephen King', ['Stephen Edwin King']), true);
  assert.equal(authorMatches('David Benioff', ['David Benioff']), true);
  assert.equal(authorMatches('Madeline Wickham & Sophie Kinsella', ['Sophie Kinsella']), true);
  assert.equal(authorMatches('Jane Austen', ['Charles Dickens']), false);
  assert.equal(authorMatches('', ['Someone']), false);
});

test('splitAuthors handles separators', () => {
  assert.deepEqual(splitAuthors('A & B'), ['A', 'B']);
  assert.deepEqual(splitAuthors('A and B'), ['A', 'B']);
  assert.deepEqual(splitAuthors('A, B'), ['A', 'B']);
});

/* ------------------------------------------------------------------ */
/* D1 shim + stub fetchers for scrape/process.                         */
/* ------------------------------------------------------------------ */

/** Minimal in-memory D1 for the expansion queries. */
function fakeDb() {
  const state = { candidates: [], runs: [], books: [], works: [], adaptations: [], slugs: new Set() };
  let nextId = 1;
  const norm = (s) => String(s ?? '').toLowerCase();
  return {
    state,
    prepare(sql) {
      const q = sql;
      const exec = (args) => ({
        async run() {
          if (q.startsWith('INSERT OR IGNORE INTO wiki_expansion_candidates')) {
            const [bt, , , ft] = args;
            const fy = args[4];
            const dup = state.candidates.some(
              (c) =>
                norm(c.book_title) === norm(bt) &&
                norm(c.film_title) === norm(ft) &&
                (c.film_year ?? null) === (fy ?? null),
            );
            if (dup) return { meta: { changes: 0 } };
            state.candidates.push({
              id: nextId++,
              book_title: bt, book_year: args[1], authors: args[2],
              film_title: ft, film_year: fy, source_list: args[5],
              status: 'pending', reason: null, attempts: 0,
            });
            return { meta: { changes: 1 } };
          }
          if (q.startsWith('INSERT INTO wiki_expansion_runs')) {
            state.runs.push({ candidates_added: args[0] });
            return { meta: {} };
          }
          if (q.startsWith('UPDATE wiki_expansion_candidates')) {
            // Two shapes: markCandidate (status, reason, ol_key, tmdb_id, id)
            // and markRetryable (reason, id).
            const id = args.length === 2 ? args[1] : args[4];
            const c = state.candidates.find((x) => x.id === id);
            if (c) {
              if (args.length === 2) {
                c.reason = args[0];
              } else {
                c.status = args[0]; c.reason = args[1];
                c.ol_work_key = args[2]; c.tmdb_id = args[3];
              }
              c.attempts++;
            }
            return { meta: {} };
          }
          throw new Error(`shim: unhandled run: ${q.slice(0, 60)}`);
        },
        async first() {
          if (q.includes('FROM adaptations a')) {
            // alreadyCataloged join — seed can pre-populate state.adaptations
            return state.adaptations.length ? { id: 1 } : null;
          }
          if (q.includes('COUNT(*)')) {
            if (q.includes("status = 'pending'")) {
              return { c: state.candidates.filter((c) => c.status === 'pending').length };
            }
            return { c: state.candidates.length };
          }
          if (q.includes('FROM screen_works WHERE tmdb_id')) return null;
          if (q.includes('FROM books WHERE openlibrary_id')) return null;
          if (q.includes('FROM adaptations WHERE book_id')) return null;
          if (q.includes('SELECT id FROM')) {
            // uniqueSlug probe: slug taken?
            const slug = args[0];
            return state.slugs.has(slug) ? { id: 1 } : null;
          }
          if (q.includes('wiki_expansion_runs ORDER BY')) return null;
          throw new Error(`shim: unhandled first: ${q.slice(0, 80)}`);
        },
        async all() {
          if (q.includes("WHERE status = 'pending'")) {
            return {
              results: state.candidates
                .filter((c) => c.status === 'pending')
                .slice(0, args[0])
                .map((c) => ({ ...c })),
            };
          }
          if (q.includes('GROUP BY status')) {
            const by = {};
            for (const c of state.candidates) by[c.status] = (by[c.status] ?? 0) + 1;
            return { results: Object.entries(by).map(([status, c]) => ({ status, c })) };
          }
          throw new Error(`shim: unhandled all: ${q.slice(0, 80)}`);
        },
      });
      // Real D1 allows .first()/.all()/.run() with no bind() when the query
      // has no parameters.
      return {
        bind: (...args) => {
          // D1 sizes the bind array by the largest ?NNN used (a repeated
          // placeholder does not consume an extra bind). Enforce that here
          // so a "Wrong number of parameter bindings" production failure is
          // caught by tests instead of the cron.
          const nums = [...q.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]));
          const maxN = nums.length ? Math.max(...nums) : 0;
          const positional = (q.match(/\?[,)\s]/g) || []).length;
          const expected = Math.max(maxN, positional);
          assert.equal(
            args.length, expected,
            `bind count mismatch for query: ${q.slice(0, 80)} (got ${args.length}, want ${expected})`,
          );
          return exec(args);
        },
        run: () => exec([]).run(),
        first: () => exec([]).first(),
        all: () => exec([]).all(),
      };
    },
    async batch(stmts) {
      const out = [];
      for (const s of stmts) {
        // The writeIntakeRecords batch: statements were already bound; the
        // shim's bind() returned objects with run/all/first — but batch
        // receives prepared statements. Simplify: our fake prepare().bind()
        // returns the executor directly, so emulate by tracking writes here.
        out.push(await s.run().catch(() => ({ meta: {} })));
      }
      return out;
    },
  };
}

test('scrapeAndStoreExpansionCandidates inserts parsed rows idempotently', async () => {
  const db = fakeDb();
  const wikiFetcher = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ parse: { text: LIST_HTML } }),
  });
  const r1 = await scrapeAndStoreExpansionCandidates(db, wikiFetcher);
  assert.equal(r1.pages, 5); // all five list pages fetched (same fixture each)
  assert.equal(r1.candidates, 30); // 6 rows × 5 pages parsed
  assert.equal(r1.alreadyKnown, 24); // unique index on (book, film): only 6 distinct
  assert.equal((await expansionStats(db)).pending, 6);

  const r2 = await scrapeAndStoreExpansionCandidates(db, wikiFetcher);
  assert.equal(r2.alreadyKnown, 30);
  assert.equal((await expansionStats(db)).pending, 6); // no duplicates
});

test('processExpansionBatch creates records on full match, skips the rest', async () => {
  const db = fakeDb();
  // Seed two pending candidates directly.
  db.state.candidates.push(
    { id: 1, book_title: 'The 25th Hour', book_year: 2001, authors: 'David Benioff', film_title: '25th Hour', film_year: 2002, source_list: 'novels-0-9-a-c', status: 'pending', attempts: 0 },
    { id: 2, book_title: 'No Such Book', book_year: 1999, authors: 'Nobody Writer', film_title: 'No Such Film', film_year: 1999, source_list: 'novels-0-9-a-c', status: 'pending', attempts: 0 },
  );

  const fetcher = async (url) => {
    const ok = (json) => ({ ok: true, status: 200, json: async () => json });
    if (url.includes('openlibrary.org/search.json') && url.includes('25th%20Hour')) {
      return ok({
        docs: [
          { key: '/works/OL1W', title: 'The 25th Hour', author_name: ['David Benioff'], first_publish_year: 2001 },
        ],
      });
    }
    if (url.includes('openlibrary.org/search.json')) return ok({ docs: [] });
    if (url.includes('openlibrary.org/works/')) {
      return ok({ description: 'A book.', subjects: ['Fiction'] });
    }
    if (url.includes('api.themoviedb.org/3/search/movie')) {
      return ok({
        results: [
          { id: 999, title: '25th Hour', poster_path: '/p.jpg', backdrop_path: null, overview: 'Film.', release_date: '2002-01-01' },
        ],
      });
    }
    return { ok: false, status: 404, json: async () => null };
  };

  // The write path needs INSERT handling for the catalog tables in this shim.
  const origPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    if (sql.startsWith('INSERT INTO screen_works') || sql.startsWith('INSERT INTO books') || sql.startsWith('INSERT INTO adaptations')) {
      return { bind: (...args) => ({ run: async () => ({ meta: { last_row_id: 42 } }) }) };
    }
    return origPrepare(sql);
  };
  // batch() must tolerate the writeIntakeRecords statements: emulate by
  // running each bound statement's run().
  db.batch = async (stmts) => {
    const out = [];
    for (const s of stmts) out.push({ meta: { last_row_id: 42 } });
    return out;
  };

  const batch = await processExpansionBatch({ DB: db, TMDB_API_KEY: 'KEY' }, 10, fetcher);
  assert.equal(batch.processed, 2);
  assert.equal(batch.created, 1);
  assert.equal(batch.skipped, 1);
  assert.equal(batch.remaining, 0);

  const created = db.state.candidates.find((c) => c.id === 1);
  assert.equal(created.status, 'created');
  assert.equal(created.ol_work_key, '/works/OL1W');
  assert.equal(created.tmdb_id, 999);
  const skipped = db.state.candidates.find((c) => c.id === 2);
  assert.equal(skipped.status, 'skipped');
  assert.match(skipped.reason, /no OL book match/);
});

test('processExpansionBatch no-ops without a TMDB key', async () => {
  const db = fakeDb();
  const batch = await processExpansionBatch({ DB: db, TMDB_API_KEY: undefined }, 10);
  assert.equal(batch.processed, 0);
  assert.equal(await countPendingExpansion(db), 0);
});

test('processExpansionBatch skips already-cataloged adaptations without API calls', async () => {  const db = fakeDb();
  db.state.candidates.push(
    { id: 1, book_title: 'Dune', book_year: 1965, authors: 'Frank Herbert', film_title: 'Dune: Part Two', film_year: 2024, source_list: 'novels-d-j', status: 'pending', attempts: 0 },
  );
  db.state.adaptations.push({ id: 1 }); // the join probe returns a row
  let calls = 0;
  const counting = async () => { calls++; return { ok: false, status: 500, json: async () => null }; };
  const batch = await processExpansionBatch({ DB: db, TMDB_API_KEY: 'KEY' }, 10, counting);
  assert.equal(batch.skipped, 1);
  assert.equal(calls, 0); // no provider calls burned
  assert.match(db.state.candidates[0].reason, /already in catalog/);
});

test('processExpansionBatch retries transient TMDB failures, then gives up', async () => {
  const db = fakeDb();
  db.state.candidates.push(
    { id: 1, book_title: 'The 25th Hour', book_year: 2001, authors: 'David Benioff', film_title: '25th Hour', film_year: 2002, source_list: 'novels-0-9-a-c', status: 'pending', attempts: 0 },
  );
  const fetcher = async (url) => {
    const ok = (json) => ({ ok: true, status: 200, json: async () => json });
    if (url.includes('openlibrary.org/search.json')) {
      return ok({ docs: [{ key: '/works/OL1W', title: 'The 25th Hour', author_name: ['David Benioff'], first_publish_year: 2001 }] });
    }
    if (url.includes('openlibrary.org/works/')) return ok({ description: 'x', subjects: [] });
    if (url.includes('api.themoviedb.org')) throw new Error('boom'); // transport failure
    return { ok: false, status: 404, json: async () => null };
  };

  // Attempt 1: stays pending, attempts bumped, not counted as failed.
  let batch = await processExpansionBatch({ DB: db, TMDB_API_KEY: 'KEY' }, 10, fetcher);
  assert.equal(batch.processed, 1);
  assert.equal(batch.failed, 0);
  let c = db.state.candidates[0];
  assert.equal(c.status, 'pending');
  assert.equal(c.attempts, 1);

  // Attempt 2: still pending.
  batch = await processExpansionBatch({ DB: db, TMDB_API_KEY: 'KEY' }, 10, fetcher);
  c = db.state.candidates[0];
  assert.equal(c.status, 'pending');
  assert.equal(c.attempts, 2);

  // Attempt 3: exhausted → failed.
  batch = await processExpansionBatch({ DB: db, TMDB_API_KEY: 'KEY' }, 10, fetcher);
  assert.equal(batch.failed, 1);
  c = db.state.candidates[0];
  assert.equal(c.status, 'failed');
  assert.match(c.reason, /TMDB error: failed/);
});
