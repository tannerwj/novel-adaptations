// tests/e2e/flows/logged-out.mjs — logged-out regression flows.
//
// Each flow asserts on BOTH the HTTP/API layer and the real client render
// output (public/js/views/* executed in Node via helpers.loadClientViews),
// i.e. what a logged-out visitor actually sees on first paint.

import {
  test,
  assert,
  eq,
  contains,
  notContains,
  countOccurrences,
  BASE,
  getPage,
  getRedirect,
  apiGet,
  apiPost,
  loadClientViews,
} from '../helpers.mjs';

const GOOGLEBOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export const tests = [
  test('home: landing page, API pagination, and featured/newest endpoints', async () => {
    const page = await getPage('/');
    eq(page.status, 200, 'GET / status');
    contains(page.text, 'id="app"', 'shell mounts the SPA root');
    contains(page.text, 'data-theme="light"', 'first-visit default is the light theme');

    // /api/v1/home still paginates in SQL with a filtered total.
    const p1 = await apiGet('/api/v1/home');
    eq(p1.status, 200, 'GET /api/v1/home status');
    eq(p1.data.adaptations.data.length, 24, 'home page 1 returns 24 adaptations');
    const total = p1.data.adaptations.total;
    assert(total >= 900, `home reports the full catalog total (got ${total})`);
    eq(p1.data.stats.total_adaptations, total, 'home stats.total_adaptations matches the catalog total');

    const p2 = await apiGet('/api/v1/home', { query: { page: '2' } });
    eq(p2.status, 200, 'GET /api/v1/home?page=2 status');
    eq(p2.data.adaptations.data.length, 24, 'home page 2 returns a full page of 24');

    // /api/v1/adaptations honors ?sort=newest (id DESC) — still SQL-paginated.
    const newest = await apiGet('/api/v1/adaptations', { query: { sort: 'newest', per_page: '8' } });
    eq(newest.status, 200, 'GET /api/v1/adaptations?sort=newest status');
    eq(newest.data.data.length, 8, 'newest page returns 8 rows');
    eq(newest.data.total, total, 'newest shares the catalog total');
    const ids = newest.data.data.map((a) => a.id);
    assert(
      ids.every((id, i) => i === 0 || id < ids[i - 1]),
      'sort=newest returns ids in descending order',
    );

    const bad = await apiGet('/api/v1/adaptations', { query: { sort: 'bogus' } });
    eq(bad.status, 422, 'unknown sort value is a 422');

    // /api/v1/home/featured: small fixed LIMIT, real poster art, vote-ranked.
    const f = await apiGet('/api/v1/home/featured', { query: { limit: '12' } });
    eq(f.status, 200, 'GET /api/v1/home/featured status');
    const feat = f.data.data;
    assert(feat.length >= 1 && feat.length <= 12, `featured returns a small rail (got ${feat.length})`);
    assert(
      feat.every((a) => a.screen_poster_url && a.screen_poster_url.trim()),
      'every featured row has real poster art',
    );
    const votes = feat.map((a) => a.book_votes);
    assert(
      votes.every((v, i) => i === 0 || v <= votes[i - 1]),
      'featured is ordered by book votes descending',
    );
    const clamped = await apiGet('/api/v1/home/featured', { query: { limit: '999' } });
    assert(clamped.data.data.length <= 24, `featured limit is clamped (got ${clamped.data.data.length})`);

    // The client home view is a landing page, not a catalog dump.
    const { home } = await loadClientViews();
    const view = await home.homeView();
    contains(view.html, 'data-hero-search', 'client home has the hero search form');
    contains(view.html, '/search?kind=film', 'client home chips link to kind-filtered search');
    contains(view.html, '/search?status=upcoming', 'client home chips link to status-filtered search');
    contains(view.html, '/calendar', 'client home links to the release calendar');
    contains(view.html, '/most-wanted', 'client home links to Most Wanted');
    const expectedCards =
      (feat.length > 0 ? feat.length : 0) +
      (newest.data.data.length > 0 ? newest.data.data.length : 0);
    eq(
      countOccurrences(view.html, 'class="poster-card"'),
      expectedCards,
      'client home renders the featured rail plus the recent grid — no catalog dump',
    );
    contains(view.html, 'href="/search"', 'client home links full-catalog browsing to search');
    notContains(view.html, 'data-load-more', 'home no longer pages the whole catalog inline');
  }),

  test('search: ranked API matches, grouped client results, empty state with suggestion CTA', async () => {
    const r = await apiGet('/api/v1/search', { query: { q: 'witcher' } });
    eq(r.status, 200, 'GET /api/v1/search status');
    const blob = JSON.stringify(r.data).toLowerCase();
    contains(blob, 'witcher', 'search for "witcher" finds The Witcher');

    // Ranked: the exact title match for "dune" outranks prefix/substring hits.
    const ranked = await apiGet('/api/v1/search', { query: { q: 'dune' } });
    eq(ranked.status, 200, 'GET /api/v1/search?q=dune status');
    const bookHits = ranked.data.books?.data ?? [];
    assert(bookHits.length > 0, 'dune search returns book hits');
    eq(bookHits[0].title, 'Dune', 'exact title match ranks first for "dune"');

    // Empty query is the paginated full-catalog browse — bounded pages, honest total.
    const browse = await apiGet('/api/v1/adaptations', { query: { per_page: '24', page: '1' } });
    eq(browse.status, 200, 'browse page 1 status');
    eq(browse.data.data.length, 24, 'browse page 1 is bounded to 24 rows');
    assert(browse.data.total >= 1000, `browse total covers the catalog (got ${browse.data.total})`);
    const browse2 = await apiGet('/api/v1/adaptations', { query: { per_page: '24', page: '2' } });
    eq(browse2.data.total, browse.data.total, 'browse total is stable across pages');
    assert(
      browse2.data.data[0].id !== browse.data.data[0].id,
      'browse page 2 advances past page 1',
    );

    const { home } = await loadClientViews();
    const dune = await home.searchView({ query: { q: 'dune' } });
    assert(countOccurrences(dune.html, '<section aria-label=') >= 1, 'dune results render grouped sections');
    contains(dune.html.toLowerCase(), 'dune', 'dune results mention Dune');
    contains(dune.html, 'role="option"', 'results are keyboard-navigable options');
    contains(dune.html, `href="/books/${bookHits[0].slug}"`, 'top book result links to its slug URL');

    const empty = await home.searchView({ query: { q: 'zzqxplork' } });
    contains(empty.html, 'No results for', 'nonsense query renders the clean empty state');
    contains(empty.html, "Can\u2019t find it? Suggest an adaptation", 'empty state offers the adaptation suggestion CTA');
    contains(empty.html, '/feedback?type=adaptation_tip', 'suggestion CTA opens the adaptation-tip feedback flow');
    contains(empty.html, 'Popular right now', 'empty state suggests popular titles');

    const kind = await home.searchView({ query: { kind: 'film' } });
    contains(kind.html, 'Browse all films', 'kind=film filter is honored in browse mode');
  }),

  test('detail pages: slug URLs, numeric 301s, content, cross-links, logged-out rating widget', async () => {
    // Resolve the canonical slugs through the API (numeric API ids are still
    // accepted), then exercise the slug page routes and the 301s.
    const bookApi = await apiGet('/api/v1/books/38');
    eq(bookApi.status, 200, 'GET /api/v1/books/38 status');
    const bookSlug = bookApi.data.book?.slug;
    assert(typeof bookSlug === 'string' && bookSlug.length > 0, 'book API exposes a slug');
    const watchApi = await apiGet('/api/v1/watch/38');
    eq(watchApi.status, 200, 'GET /api/v1/watch/38 status');
    const watchSlug = watchApi.data.work?.slug;
    assert(typeof watchSlug === 'string' && watchSlug.length > 0, 'watch API exposes a slug');
    const adaptApi = await apiGet('/api/v1/adaptations/38');
    eq(adaptApi.status, 200, 'GET /api/v1/adaptations/38 status');
    const adaptSlug = adaptApi.data.adaptation?.adaptation_slug;
    assert(typeof adaptSlug === 'string' && adaptSlug.length > 0, 'adaptation API exposes a slug');

    for (const [path, slug] of [['/books', bookSlug], ['/watch', watchSlug], ['/adaptations', adaptSlug]]) {
      const p = await getPage(`${path}/${slug}`);
      eq(p.status, 200, `GET ${path}/${slug} status`);
    }
    for (const [path, slug] of [['/books', bookSlug], ['/watch', watchSlug], ['/adaptations', adaptSlug]]) {
      const r = await getRedirect(`${path}/38`);
      eq(r.status, 301, `GET ${path}/38 is a 301`);
      eq(r.location, `${BASE}${path}/${slug}`, `numeric ${path}/38 redirects to the slug permalink`);
    }

    const { detail, store } = await loadClientViews();
    store.user = null;
    store.sessionLoaded = false;

    const book = await detail.bookView({ params: { slug: bookSlug } });
    assert(book.title.length > 0, 'book view has a title');
    contains(book.html, '<h1>', 'book view renders a headline');
    contains(book.html, '/adaptations/', 'book view cross-links to its adaptation story');
    notContains(book.html, 'themoviedb.org/movie', 'book view has no per-page TMDB link');
    notContains(book.html, 'themoviedb.org/tv', 'book view has no per-page TMDB link');

    const watch = await detail.watchView({ params: { slug: watchSlug } });
    assert(watch.title.length > 0, 'watch view has a title');
    contains(watch.html, 'image.tmdb.org', 'watch view uses TMDB poster art');
    contains(watch.html, 'justwatch.com/us/search?q=', 'watch view links providers to JustWatch search');
    notContains(watch.html, 'themoviedb.org/movie', 'watch view has no per-page TMDB link');
    notContains(watch.html, 'themoviedb.org/tv', 'watch view has no per-page TMDB link');
    contains(watch.html, '/books/', 'watch view cross-links to its book');
    contains(watch.html, 'Sign in to rate', 'logged-out watch view shows the sign-in prompt');
    contains(watch.html, 'data-signed-in="0"', 'logged-out rating widget is marked signed-out');
    notContains(watch.html, 'type="radio"', 'logged-out rating widget has no radio inputs');
    notContains(watch.html, 'role="radio"', 'logged-out rating widget has no radio roles');

    const story = await detail.adaptationView({ params: { slug: adaptSlug } });
    assert(story.title.length > 0, 'adaptation view has a title');
    contains(story.html, '/watch/', 'adaptation view cross-links to the screen work');
    contains(story.html, '/books/', 'adaptation view cross-links to the book');
    notContains(story.html, 'themoviedb.org/movie', 'adaptation view has no per-page TMDB link');
    notContains(story.html, 'themoviedb.org/tv', 'adaptation view has no per-page TMDB link');
  }),

  test('footer: exactly one TMDB attribution, no per-page TMDB links', async () => {
    const page = await getPage('/');
    eq(page.status, 200, 'GET / status');
    contains(
      page.text,
      'This product uses the TMDB API but is not endorsed or certified by TMDB.',
      'footer carries the exact TMDB attribution wording',
    );
    eq(
      countOccurrences(page.text, 'This product uses the TMDB API but is not endorsed or certified by TMDB.'),
      1,
      'the TMDB attribution appears exactly once',
    );
  }),

  test('calendar: API buckets and client year groupings', async () => {
    const r = await apiGet('/api/v1/calendar');
    eq(r.status, 200, 'GET /api/v1/calendar status');
    // Earlier releases arrive as year summaries (lazy-loaded per year);
    // the full catalog must be accounted for across the summaries.
    assert(
      Array.isArray(r.data.earlier_years) && r.data.earlier_years.length > 0,
      'calendar returns earlier-year summaries',
    );
    const totalEarlier = r.data.earlier_years.reduce((n, y) => n + y.count, 0);
    assert(
      totalEarlier >= 900,
      `calendar year summaries cover the full earlier catalog (got ${totalEarlier})`,
    );
    // Newest year's items ship inline and match its summary count.
    const newest = r.data.earlier_years[0];
    eq(
      r.data.earlier_releases.length,
      newest.count,
      'newest year ships its items inline',
    );
    assert(
      r.data.earlier_releases.every((w) => (w.release_date || '').startsWith(newest.year)),
      'inline earlier releases all belong to the newest year',
    );
    // Lazy year endpoint serves a collapsed year on demand.
    const yr = await apiGet(`/api/v1/calendar/year/${newest.year}`);
    eq(yr.status, 200, 'GET /api/v1/calendar/year/:year status');
    eq(yr.data.works.length, newest.count, 'year endpoint returns the full year');
    const bad = await apiGet('/api/v1/calendar/year/notayear');
    eq(bad.status, 400, 'year endpoint rejects a malformed year');
    // Only the truly dateless works are TBA.
    eq(r.data.tba.length, 3, 'calendar has exactly 3 TBA titles');
    const tbaTitles = r.data.tba.map((w) => w.title).sort();
    eq(
      JSON.stringify(tbaTitles),
      JSON.stringify(['A Court of Thorns and Roses', 'Fourth Wing', 'The Midnight Library']),
      'TBA titles are the three unreleased works',
    );

    const { home } = await loadClientViews();
    const view = await home.calendarView();
    contains(view.html, 'Earlier releases', 'calendar view renders the Earlier releases section');
    contains(view.html, `>${newest.year}<`, 'calendar view groups earlier releases by year');
    contains(view.html, 'data-cal-year', 'calendar year groups lazy-load on open');
    contains(view.html, 'Fourth Wing', 'calendar view lists the TBA titles');
  }),

  test('most wanted: renders; vote endpoint requires login', async () => {
    const page = await getPage('/most-wanted');
    eq(page.status, 200, 'GET /most-wanted status');

    const { home } = await loadClientViews();
    const view = await home.mostWantedView();
    assert(view.html.length > 100, 'most-wanted view renders content');
    assert(
      view.html.includes('data-vote-btn') || view.html.includes('No votes yet'),
      'most-wanted view renders vote controls or the empty state',
    );

    const vote = await apiPost('/api/v1/votes', { body: { book_id: 38 } });
    eq(vote.status, 401, 'logged-out vote POST is rejected');
    eq(vote.data?.error?.code, 'unauthorized', 'logged-out vote uses the error envelope');
  }),

  test('404: unknown route returns the branded shell with 404 status', async () => {
    const p = await getPage('/nope-xyz-123');
    eq(p.status, 404, 'GET /nope-xyz-123 status');
    contains(p.text, 'id="app"', '404 serves the SPA shell so the router renders branding');
    const bundle = await getPage('/js/router.js');
    eq(bundle.status, 200, 'client router module is served');
    contains(bundle.text, 'Page not found', 'client bundle contains the branded 404 copy');
  }),

  test('bot prerender: crawler gets OG metadata and slug canonical, users get the shell', async () => {
    const watchApi = await apiGet('/api/v1/watch/1');
    const watchSlug = watchApi.data.work?.slug;
    assert(typeof watchSlug === 'string' && watchSlug.length > 0, 'watch API exposes a slug for id 1');

    const bot = await getPage(`/watch/${watchSlug}`, { ua: GOOGLEBOT_UA });
    eq(bot.status, 200, `bot GET /watch/${watchSlug} status`);
    contains(bot.text, 'og:title', 'bot HTML carries Open Graph tags');
    contains(bot.text, 'Dune: Part Two', 'bot OG title is the work title');
    contains(bot.text, 'image.tmdb.org', 'bot OG image is TMDB poster art');
    contains(bot.text, `rel="canonical" href="https://noveladaptations.com/watch/${watchSlug}"`, 'bot canonical is the slug permalink');
    contains(bot.text, `property="og:url" content="https://noveladaptations.com/watch/${watchSlug}"`, 'bot OG url is the slug permalink');

    // Numeric URLs 301 to the slug even for crawlers — no duplicate indexing.
    const botNumeric = await getRedirect('/watch/1', { ua: GOOGLEBOT_UA });
    eq(botNumeric.status, 301, 'bot GET /watch/1 is a 301');
    eq(botNumeric.location, `${BASE}/watch/${watchSlug}`, 'bot numeric URL redirects to the slug');

    const user = await getPage(`/watch/${watchSlug}`, { ua: CHROME_UA });
    eq(user.status, 200, 'user GET slug watch page status');
    contains(user.text, 'id="app"', 'normal user gets the SPA shell');
    notContains(user.text, '<meta property="og:title" content="Dune: Part Two', 'shell does not leak the prerendered OG title');
  }),

  test('sitemap: slug permalinks for every title, no numeric entries', async () => {
    const sm = await getPage('/sitemap.xml');
    eq(sm.status, 200, 'GET /sitemap.xml status');
    contains(sm.text, '<loc>https://noveladaptations.com/watch/dune-part-two-2024</loc>', 'sitemap lists the watch slug URL');
    contains(sm.text, '<loc>https://noveladaptations.com/books/dune-frank-herbert</loc>', 'sitemap lists the book slug URL');
    contains(sm.text, '<loc>https://noveladaptations.com/adaptations/dune-part-two-2024</loc>', 'sitemap lists the adaptation slug URL');
    notContains(sm.text, '<loc>https://noveladaptations.com/watch/1</loc>', 'sitemap has no numeric watch entries');
    notContains(sm.text, '<loc>https://noveladaptations.com/books/1</loc>', 'sitemap has no numeric book entries');
    notContains(sm.text, '<loc>https://noveladaptations.com/adaptations/1</loc>', 'sitemap has no numeric adaptation entries');
  }),

  test('theme: cookie drives data-theme and theme-color on first paint', async () => {
    const dark = await getPage('/', { cookie: 'theme=dark' });
    contains(dark.text, 'data-theme="dark"', 'theme=dark cookie renders dark on the server');
    contains(dark.text, 'content="#0b0c10"', 'dark theme-color meta matches the dark chrome');

    const light = await getPage('/', { cookie: 'theme=light' });
    contains(light.text, 'data-theme="light"', 'theme=light cookie renders light on the server');
    contains(light.text, 'content="#faf9f6"', 'light theme-color meta matches the light chrome');

    const none = await getPage('/');
    contains(none.text, 'data-theme="light"', 'no cookie defaults to light');
  }),

  test('API surface: OpenAPI JSON and interactive docs', async () => {
    const spec = await getPage('/api/openapi.json');
    eq(spec.status, 200, 'GET /api/openapi.json status');
    const parsed = JSON.parse(spec.text);
    assert(parsed.openapi && parsed.paths, 'openapi.json is a valid OpenAPI document');
    assert(Object.keys(parsed.paths).length > 30, 'OpenAPI covers the full route surface');

    const docs = await getPage('/api/docs');
    eq(docs.status, 200, 'GET /api/docs status');
    assert(/redoc/i.test(docs.text), 'API docs page loads the Redoc renderer');
  }),
];
