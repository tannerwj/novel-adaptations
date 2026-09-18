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
} = prerender;
const { llmsTxt } = seo;

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
