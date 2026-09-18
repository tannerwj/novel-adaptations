// tests/unit/geo.test.mjs — GEO package: JSON-LD builders, prerenderDoc
// script-tag safety, AI-crawler detection, and llms.txt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./hooks/extensionless.mjs', import.meta.url));
const prerender = await import('../../src/prerender.ts');
const seo = await import('../../src/seo.ts');

const {
  prerenderDoc,
  serializeJsonLd,
  screenWorkJsonLd,
  bookJsonLd,
  websiteJsonLd,
  parseSubjects,
  isCrawler,
  breadcrumbListJsonLd,
  videoObjectJsonLd,
  jsonLdGraph,
} = prerender;
const { llmsTxt, buildSitemap, buildRssFeed, llmsFullTxt } = seo;

test('serializeJsonLd escapes < to block </script> breakout', () => {
  const out = serializeJsonLd({ name: '</script><script>alert(1)</script>' });
  assert.ok(!out.includes('</script>'), 'raw closing tag must not appear');
  assert.ok(out.includes('\\u003c/script>'), 'escaped form present');
  // Still valid JSON describing the same value.
  assert.equal(JSON.parse(out).name, '</script><script>alert(1)</script>');
});

test('prerenderDoc emits a JSON-LD script tag when jsonLd is provided', () => {
  const html = prerenderDoc({
    title: 'Dune: Part Two',
    description: 'A film.',
    canonical: 'https://noveladaptations.com/watch/dune-part-two-2024',
    image: 'https://noveladaptations.com/og-card.jpg',
    body: '<h1>Dune: Part Two</h1>',
    jsonLd: { '@context': 'https://schema.org', '@type': 'Movie', name: 'Dune: Part Two' },
  });
  assert.ok(html.includes('<script type="application/ld+json">'), 'script tag present');
  assert.ok(html.includes('"@type":"Movie"'), 'entity serialized');
});

test('prerenderDoc omits the JSON-LD tag when jsonLd is absent', () => {
  const html = prerenderDoc({
    title: 'T',
    description: 'D',
    canonical: 'https://noveladaptations.com/',
    image: 'https://noveladaptations.com/og-card.jpg',
    body: '<h1>T</h1>',
  });
  assert.ok(!html.includes('application/ld+json'), 'no script tag');
});

test('screenWorkJsonLd types film vs series and links isBasedOn books', () => {
  const film = screenWorkJsonLd({
    title: 'Dune: Part Two',
    kind: 'film',
    releaseDate: '2024-03-01',
    description: 'A film.',
    canonical: 'https://noveladaptations.com/watch/dune-part-two-2024',
    image: 'https://img/poster.jpg',
    books: [{ title: 'Dune', authors: 'Frank Herbert' }],
  });
  assert.equal(film['@type'], 'Movie');
  assert.equal(film.datePublished, '2024-03-01');
  assert.deepEqual(film.isBasedOn, [
    { '@type': 'Book', name: 'Dune', author: 'Frank Herbert' },
  ]);

  const series = screenWorkJsonLd({
    title: 'The Witcher',
    kind: 'series',
    releaseDate: null,
    description: 'A series.',
    canonical: 'https://noveladaptations.com/watch/the-witcher-2019',
    image: 'https://img/p.jpg',
    books: [],
  });
  assert.equal(series['@type'], 'TVSeries');
  assert.ok(!('datePublished' in series), 'no datePublished without a release date');
  assert.ok(!('isBasedOn' in series), 'no isBasedOn without linked books');
});

test('bookJsonLd carries author, date, description, and genre subjects', () => {
  const b = bookJsonLd({
    title: 'Dune',
    authors: 'Frank Herbert',
    pubDate: '1965-08-01',
    description: 'A desert epic.',
    canonical: 'https://noveladaptations.com/books/dune-frank-herbert',
    image: 'https://img/cover.jpg',
    subjects: ['Science fiction', 'Dystopias'],
  });
  assert.equal(b['@type'], 'Book');
  assert.equal(b.author, 'Frank Herbert');
  assert.equal(b.datePublished, '1965-08-01');
  assert.equal(b.description, 'A desert epic.');
  assert.deepEqual(b.genre, ['Science fiction', 'Dystopias']);
});

test('bookJsonLd omits empty optional fields', () => {
  const b = bookJsonLd({
    title: 'X',
    authors: 'Y',
    pubDate: null,
    description: null,
    canonical: 'https://noveladaptations.com/books/x',
    image: 'https://noveladaptations.com/og-card.jpg',
    subjects: [],
  });
  assert.ok(!('description' in b));
  assert.ok(!('datePublished' in b));
  assert.ok(!('genre' in b));
});

test('websiteJsonLd is a WebSite with a SearchAction', () => {
  const w = websiteJsonLd('https://noveladaptations.com');
  assert.equal(w['@type'], 'WebSite');
  assert.equal(w.url, 'https://noveladaptations.com/');
  assert.equal(w.potentialAction['@type'], 'SearchAction');
  assert.ok(w.potentialAction.target.includes('/search?q={query}'));
});

test('parseSubjects parses the JSON column and degrades safely', () => {
  assert.deepEqual(parseSubjects('["A", "B"]'), ['A', 'B']);
  assert.deepEqual(parseSubjects(null), []);
  assert.deepEqual(parseSubjects('not json'), []);
  assert.deepEqual(parseSubjects('{"a":1}'), []);
  assert.deepEqual(parseSubjects('[1, "B", null]'), ['B']);
});

test('isCrawler recognizes AI training/inference crawlers', () => {
  for (const ua of [
    'Mozilla/5.0 (compatible; GPTBot/1.0; +https://openai.com/gptbot)',
    'ClaudeBot/1.0 (+https://support.anthropic.com)',
    'Mozilla/5.0 Applebot/0.1',
    'ChatGPT-User/1.0; +https://openai.com/bot',
    'Google-Extended/1.0',
    'PerplexityBot/1.0',
  ]) {
    assert.ok(isCrawler(ua), `should treat as crawler: ${ua}`);
  }
  assert.ok(
    !isCrawler('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15'),
    'real browser is not a crawler',
  );
});

test('llmsTxt references origin-based sitemap, API docs, and page patterns', () => {
  const txt = llmsTxt('https://noveladaptations.com', 1249);
  assert.ok(txt.startsWith('# Novel Adaptations'));
  assert.ok(txt.includes('1,249 adaptations'), 'dynamic count rendered');
  assert.ok(txt.includes('https://noveladaptations.com/sitemap.xml'));
  assert.ok(txt.includes('https://noveladaptations.com/api/docs'));
  assert.ok(txt.includes('/books/{slug}'));
  assert.ok(txt.includes('/watch/{slug}'));
  assert.ok(txt.includes('application/ld+json') || txt.includes('JSON-LD'));
});

test('PRERENDER_CACHE_VERSION is a positive integer (bump on shape changes)', async () => {
  const { PRERENDER_CACHE_VERSION } = prerender;
  assert.ok(Number.isInteger(PRERENDER_CACHE_VERSION) && PRERENDER_CACHE_VERSION > 0);
});

test('screenWorkJsonLd emits AggregateRating only when the crowd has rated', () => {
  const base = {
    title: 'Dune: Part Two',
    kind: 'film',
    releaseDate: '2024-03-01',
    description: 'd',
    canonical: 'https://noveladaptations.com/watch/dune-part-two-2024',
    image: 'https://noveladaptations.com/og-card.jpg',
    books: [],
  };
  const rated = screenWorkJsonLd({ ...base, rating: { average: 4.5, count: 12 } });
  assert.equal(rated.aggregateRating['@type'], 'AggregateRating');
  assert.equal(rated.aggregateRating.ratingValue, 4.5);
  assert.equal(rated.aggregateRating.ratingCount, 12);
  assert.equal(rated.aggregateRating.bestRating, 5);
  const unrated = screenWorkJsonLd({ ...base, rating: { average: 0, count: 0 } });
  assert.ok(!('aggregateRating' in unrated), 'no rating node on zero votes');
  const legacy = screenWorkJsonLd(base);
  assert.ok(!('aggregateRating' in legacy), 'rating optional — old callers unaffected');
});

test('bookJsonLd emits AggregateRating when rated', () => {
  const b = bookJsonLd({
    title: 'Dune',
    authors: 'Frank Herbert',
    pubDate: '1965-08-01',
    description: null,
    canonical: 'https://noveladaptations.com/books/dune-frank-herbert',
    image: 'https://noveladaptations.com/og-card.jpg',
    subjects: [],
    rating: { average: 4.8, count: 30 },
  });
  assert.equal(b.aggregateRating.ratingValue, 4.8);
  assert.equal(b.aggregateRating.ratingCount, 30);
});

test('breadcrumbListJsonLd builds ordered absolute breadcrumbs', () => {
  const bc = breadcrumbListJsonLd('https://noveladaptations.com', [
    { name: 'Home', path: '/' },
    { name: 'Dune: Part Two', path: '/watch/dune-part-two-2024' },
  ]);
  assert.equal(bc['@type'], 'BreadcrumbList');
  assert.equal(bc.itemListElement.length, 2);
  assert.equal(bc.itemListElement[0].position, 1);
  assert.equal(bc.itemListElement[1].item, 'https://noveladaptations.com/watch/dune-part-two-2024');
});

test('videoObjectJsonLd derives YouTube URLs from the cached key', () => {
  const v = videoObjectJsonLd({
    title: 'Dune: Part Two',
    description: 'd',
    youtubeKey: 'Way9Dexny3w',
    uploadDate: '2024-03-01',
  });
  assert.equal(v['@type'], 'VideoObject');
  assert.equal(v.thumbnailUrl, 'https://i.ytimg.com/vi/Way9Dexny3w/hqdefault.jpg');
  assert.equal(v.embedUrl, 'https://www.youtube.com/embed/Way9Dexny3w');
  assert.equal(v.uploadDate, '2024-03-01');
  const noDate = videoObjectJsonLd({ title: 'X', description: 'd', youtubeKey: 'abc', uploadDate: null });
  assert.ok(!('uploadDate' in noDate), 'no uploadDate without a valid date');
});

test('jsonLdGraph: none/single/multi node composition', () => {
  assert.equal(jsonLdGraph(undefined, undefined), undefined, 'no nodes → no JSON-LD');
  const single = { '@context': 'https://schema.org', '@type': 'Movie', name: 'Dune' };
  assert.equal(jsonLdGraph(single, undefined), single, 'single node returned unchanged');
  const bc = breadcrumbListJsonLd('https://noveladaptations.com', [{ name: 'Home', path: '/' }]);
  const graph = jsonLdGraph(single, bc);
  assert.equal(graph['@context'], 'https://schema.org');
  assert.equal(graph['@graph'].length, 2);
  assert.equal(graph['@graph'][0]['@type'], 'Movie');
  assert.ok(!('@context' in graph['@graph'][0]), 'nested @context hoisted to the top');
  assert.equal(graph['@graph'][1]['@type'], 'BreadcrumbList');
  // The graph still serializes safely inside a script tag.
  assert.ok(serializeJsonLd(graph).includes('"@type":"Movie"'));
});

test('buildSitemap adds the image extension only when images exist', () => {
  const withImages = buildSitemap([
    { loc: 'https://noveladaptations.com/', images: [] },
    {
      loc: 'https://noveladaptations.com/watch/dune-part-two-2024',
      lastmod: '2024-03-01',
      images: ['https://image.tmdb.org/t/p/w500/poster.jpg'],
    },
  ]);
  assert.ok(withImages.includes('xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"'));
  assert.ok(withImages.includes('<image:loc>https://image.tmdb.org/t/p/w500/poster.jpg</image:loc>'));
  const plain = buildSitemap([{ loc: 'https://noveladaptations.com/' }]);
  assert.ok(!plain.includes('xmlns:image'), 'no image namespace when no entry has images');
});

test('buildRssFeed renders RSS 2.0 with RFC 822 dates and escaped text', () => {
  const feed = buildRssFeed('https://noveladaptations.com', [
    {
      title: 'Dune: Part Three <rumor>',
      link: 'https://example.com/news/1',
      description: 'A & B talk sequels',
      pubDate: '2026-09-18 12:00:00',
      source: 'Variety',
    },
    { title: 'No date item', link: 'https://example.com/news/2', description: null, pubDate: null, source: 'Blog' },
  ]);
  assert.ok(feed.includes('<rss version="2.0">'));
  assert.ok(feed.includes('<title>Dune: Part Three &lt;rumor&gt;</title>'), 'title escaped');
  assert.ok(feed.includes('<description>A &amp; B talk sequels</description>'), 'description escaped');
  assert.ok(feed.includes('<pubDate>Fri, 18 Sep 2026 12:00:00 GMT</pubDate>'), 'UTC pubDate');
  assert.equal((feed.match(/<item>/g) ?? []).length, 2);
  assert.equal((feed.match(/<pubDate>/g) ?? []).length, 1, 'null date omits pubDate');
  const empty = buildRssFeed('https://noveladaptations.com', []);
  assert.ok(empty.includes('<channel>') && !empty.includes('<item>'), 'empty feed is still valid');
});

test('llmsFullTxt dumps one machine-readable line per adaptation', () => {
  const txt = llmsFullTxt('https://noveladaptations.com', [
    {
      a_slug: 'dune-part-two-2024', a_id: 1, status: 'released',
      book_title: 'Dune', authors: 'Frank Herbert', b_slug: 'dune-frank-herbert', b_id: 2,
      screen_title: 'Dune: Part Two', kind: 'film', release_date: '2024-03-01',
      s_slug: 'dune-part-two-2024', s_id: 3,
    },
    {
      a_slug: null, a_id: 4, status: 'rumored',
      book_title: 'Fourth Wing', authors: 'Rebecca Yarros', b_slug: null, b_id: 5,
      screen_title: 'Fourth Wing', kind: 'series', release_date: null,
      s_slug: null, s_id: 6,
    },
  ]);
  assert.ok(txt.startsWith('# Novel Adaptations — full catalog'));
  assert.ok(txt.includes('Dune by Frank Herbert → Dune: Part Two (film, 2024) — released'));
  assert.ok(txt.includes('https://noveladaptations.com/adaptations/dune-part-two-2024'));
  assert.ok(txt.includes('Fourth Wing by Rebecca Yarros → Fourth Wing (TV series, TBA) — rumored'));
  assert.ok(txt.includes('/adaptations/4'), 'numeric fallback when slug is null');
});

test('llmsTxt advertises the full catalog dump and the RSS feed', () => {
  const txt = llmsTxt('https://noveladaptations.com', 1249);
  assert.ok(txt.includes('https://noveladaptations.com/llms-full.txt'));
  assert.ok(txt.includes('https://noveladaptations.com/feed.xml'));
});
