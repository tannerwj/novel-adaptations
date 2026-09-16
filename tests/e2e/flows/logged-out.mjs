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
  getPage,
  apiGet,
  apiPost,
  loadClientViews,
} from '../helpers.mjs';

const GOOGLEBOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export const tests = [
  test('home: page, API pagination, and client grid', async () => {
    const page = await getPage('/');
    eq(page.status, 200, 'GET / status');
    contains(page.text, 'id="app"', 'shell mounts the SPA root');
    contains(page.text, 'data-theme="light"', 'first-visit default is the light theme');

    const p1 = await apiGet('/api/v1/home');
    eq(p1.status, 200, 'GET /api/v1/home status');
    eq(p1.data.adaptations.data.length, 24, 'home page 1 returns 24 adaptations');
    const total = p1.data.adaptations.total;
    assert(total >= 900, `home reports the full catalog total (got ${total})`);
    eq(p1.data.stats.total_adaptations, total, 'home stats.total_adaptations matches the catalog total');

    const p2 = await apiGet('/api/v1/home', { query: { page: '2' } });
    eq(p2.status, 200, 'GET /api/v1/home?page=2 status');
    eq(p2.data.adaptations.data.length, 24, 'home page 2 returns a full page of 24');

    const { home } = await loadClientViews();
    const view = await home.homeView();
    eq(countOccurrences(view.html, 'class="poster-card"'), 24, 'client home view renders 24 cards');
    contains(view.html, 'Load more', 'client home view has a Load more button');
    contains(view.html, `(${total - 24} of ${total} remaining)`, 'Load more button shows the remaining count');
  }),

  test('search: API match, grouped client results, empty state', async () => {
    const r = await apiGet('/api/v1/search', { query: { q: 'witcher' } });
    eq(r.status, 200, 'GET /api/v1/search status');
    const blob = JSON.stringify(r.data).toLowerCase();
    contains(blob, 'witcher', 'search for "witcher" finds The Witcher');

    const { home } = await loadClientViews();
    const dune = await home.searchView({ query: { q: 'dune' } });
    assert(countOccurrences(dune.html, '<section aria-label=') >= 1, 'dune results render grouped sections');
    contains(dune.html.toLowerCase(), 'dune', 'dune results mention Dune');

    const empty = await home.searchView({ query: { q: 'zzqxplork' } });
    contains(empty.html, 'No results for', 'nonsense query renders the clean empty state');
    contains(empty.html, 'Popular right now', 'empty state suggests popular titles');
  }),

  test('detail pages: content, cross-links, logged-out rating widget', async () => {
    for (const path of ['/books/38', '/watch/38', '/adaptations/38']) {
      const p = await getPage(path);
      eq(p.status, 200, `GET ${path} status`);
    }
    const { detail, store } = await loadClientViews();
    store.user = null;
    store.sessionLoaded = false;

    const book = await detail.bookView({ params: { id: '38' } });
    assert(book.title.length > 0, 'book view has a title');
    contains(book.html, '<h1>', 'book view renders a headline');
    contains(book.html, '/adaptations/', 'book view cross-links to its adaptation story');

    const watch = await detail.watchView({ params: { id: '38' } });
    assert(watch.title.length > 0, 'watch view has a title');
    contains(watch.html, 'image.tmdb.org', 'watch view uses TMDB poster art');
    contains(watch.html, 'themoviedb.org', 'watch view links out to TMDB');
    contains(watch.html, '/books/', 'watch view cross-links to its book');
    contains(watch.html, 'Sign in to rate', 'logged-out watch view shows the sign-in prompt');
    contains(watch.html, 'data-signed-in="0"', 'logged-out rating widget is marked signed-out');
    notContains(watch.html, 'type="radio"', 'logged-out rating widget has no radio inputs');
    notContains(watch.html, 'role="radio"', 'logged-out rating widget has no radio roles');

    const story = await detail.adaptationView({ params: { id: '38' } });
    assert(story.title.length > 0, 'adaptation view has a title');
    contains(story.html, '/watch/', 'adaptation view cross-links to the screen work');
    contains(story.html, '/books/', 'adaptation view cross-links to the book');
  }),

  test('calendar: API buckets and client year groupings', async () => {
    const r = await apiGet('/api/v1/calendar');
    eq(r.status, 200, 'GET /api/v1/calendar status');
    eq(r.data.earlier_releases.length, 37, 'calendar has 37 earlier releases');
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
    contains(view.html, '>2025<', 'calendar view groups earlier releases by year');
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

  test('bot prerender: crawler gets OG metadata, users get the shell', async () => {
    const bot = await getPage('/watch/1', { ua: GOOGLEBOT_UA });
    eq(bot.status, 200, 'bot GET /watch/1 status');
    contains(bot.text, 'og:title', 'bot HTML carries Open Graph tags');
    contains(bot.text, 'Dune: Part Two', 'bot OG title is the work title');
    contains(bot.text, 'image.tmdb.org', 'bot OG image is TMDB poster art');

    const user = await getPage('/watch/1', { ua: CHROME_UA });
    eq(user.status, 200, 'user GET /watch/1 status');
    contains(user.text, 'id="app"', 'normal user gets the SPA shell');
    notContains(user.text, '<meta property="og:title" content="Dune: Part Two', 'shell does not leak the prerendered OG title');
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
