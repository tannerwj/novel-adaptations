// tests/unit/agent.test.mjs — agent-readiness surface: Markdown negotiation,
// HTML→Markdown conversion, RFC 9727 API catalog, Agent Skills discovery,
// RFC 8288 Link headers, and robots.txt Content Signals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createHash } from 'node:crypto';

register(new URL('./hooks/extensionless.mjs', import.meta.url));
const agent = await import('../../src/agent.ts');
const seo = await import('../../src/seo.ts');

const {
  acceptsMarkdown,
  htmlToMarkdown,
  prerenderToMarkdown,
  estimateTokens,
  apiCatalog,
  agentSkillMarkdown,
  agentSkillsIndex,
  agentLinkHeader,
} = agent;
const { robotsTxt } = seo;

const ORIGIN = 'https://noveladaptations.com';

// --- Accept: text/markdown negotiation -------------------------------------

test('acceptsMarkdown matches explicit markdown requests only', () => {
  assert.equal(acceptsMarkdown('text/markdown'), true);
  assert.equal(acceptsMarkdown('text/html, text/markdown;q=0.9'), true);
  assert.equal(acceptsMarkdown('TEXT/MARKDOWN'), true);
  assert.equal(acceptsMarkdown('text/markdown;q=0'), false);
  assert.equal(acceptsMarkdown('text/html'), false);
  assert.equal(acceptsMarkdown('*/*'), false);
  assert.equal(acceptsMarkdown(null), false);
  assert.equal(acceptsMarkdown(undefined), false);
});

// --- HTML → Markdown ---------------------------------------------------------

test('htmlToMarkdown converts headings, paragraphs, links, lists, images', () => {
  const html =
    `<h1>Dune</h1>` +
    `<p>A film adapted from <a href="/books/dune-frank-herbert">Dune</a>.</p>` +
    `<h2>Adaptations</h2><ul><li><a href="/adaptations/dune-2021">Dune (2021)</a> — Released</li></ul>` +
    `<img src="https://img.example/p.jpg" alt="Dune poster" width="500">`;
  const md = htmlToMarkdown(html, ORIGIN);
  assert.ok(md.includes('# Dune'), 'h1');
  assert.ok(
    md.includes('[Dune](https://noveladaptations.com/books/dune-frank-herbert)'),
    'relative link resolved to absolute',
  );
  assert.ok(md.includes('## Adaptations'), 'h2');
  assert.ok(
    md.includes('- [Dune \\(2021\\)](https://noveladaptations.com/adaptations/dune-2021) — Released'),
    'list item with link',
  );
  assert.ok(md.includes('![Dune poster](https://img.example/p.jpg)'), 'image');
  assert.ok(!md.includes('<'), 'no HTML tags leak through');
});

test('htmlToMarkdown unescapes entities and escapes markdown syntax in text', () => {
  const md = htmlToMarkdown('<p>Fish &amp; Chips *today*</p>', ORIGIN);
  assert.ok(md.includes('Fish & Chips'), 'entity decoded');
  assert.ok(md.includes('\\*today\\*'), 'literal asterisks escaped, not emphasis');
});

test('htmlToMarkdown degrades unknown tags to their text', () => {
  const md = htmlToMarkdown('<div><span>hello</span></div>', ORIGIN);
  assert.equal(md, 'hello');
});

// --- Full Markdown document ---------------------------------------------------

test('prerenderToMarkdown emits frontmatter, body, and fenced JSON-LD', () => {
  const md = prerenderToMarkdown(
    {
      title: 'Dune (2021) — Novel Adaptations',
      description: 'Dune (Film), released 2021.',
      canonical: `${ORIGIN}/watch/dune-2021`,
      image: `${ORIGIN}/og-card.jpg`,
      body: '<h1>Dune</h1><p>Desert epic.</p>',
      jsonLd: { '@context': 'https://schema.org', '@type': 'Movie', name: 'Dune' },
    },
    ORIGIN,
  );
  assert.ok(md.startsWith('---\n'), 'frontmatter opens');
  assert.ok(md.includes('title: "Dune (2021) — Novel Adaptations"'), 'frontmatter title');
  assert.ok(md.includes('# Dune'), 'body heading');
  assert.ok(md.includes('```json'), 'fenced block opens');
  assert.ok(md.includes('"@type": "Movie"'), 'JSON-LD payload present');
  assert.ok(md.endsWith('\n') && !md.endsWith('\n\n'), 'single trailing newline');
});

test('prerenderToMarkdown omits the JSON-LD fence when absent', () => {
  const md = prerenderToMarkdown(
    {
      title: 'T',
      description: 'D',
      canonical: `${ORIGIN}/`,
      image: `${ORIGIN}/og-card.jpg`,
      body: '<p>Hi.</p>',
    },
    ORIGIN,
  );
  assert.ok(!md.includes('```json'), 'no fence without JSON-LD');
});

test('estimateTokens is ceil(len/4) with a floor of 1', () => {
  assert.equal(estimateTokens(''), 1);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2);
});

// --- API catalog (RFC 9727) ----------------------------------------------------

test('apiCatalog points at the real OpenAPI spec and docs', () => {
  const catalog = apiCatalog(ORIGIN);
  const entry = catalog.linkset[0];
  assert.equal(entry.anchor, `${ORIGIN}/`);
  assert.equal(entry['service-desc'][0].href, `${ORIGIN}/api/openapi.json`);
  assert.equal(entry['service-doc'][0].href, `${ORIGIN}/api/docs`);
});

// --- Agent Skills discovery ----------------------------------------------------

test('agentSkillsIndex has the schema, skill entry, and a valid digest', () => {
  const skill = agentSkillMarkdown(ORIGIN);
  assert.ok(skill.includes(ORIGIN), 'origin filled into skill');
  assert.ok(skill.includes('Accept: text/markdown'), 'skill documents markdown negotiation');
  const digest = createHash('sha256').update(skill, 'utf8').digest('hex');
  const index = agentSkillsIndex(ORIGIN, digest);
  assert.equal(index.$schema, 'https://schemas.agentskills.io/discovery/0.2.0/schema.json');
  const [entry] = index.skills;
  assert.equal(entry.name, 'novel-adaptations');
  assert.equal(entry.type, 'skill-md');
  assert.equal(entry.url, `${ORIGIN}/.well-known/agent-skills/novel-adaptations/SKILL.md`);
  assert.equal(entry.digest, `sha256:${digest}`);
  assert.match(entry.digest, /^sha256:[0-9a-f]{64}$/);
});

// --- Link header ---------------------------------------------------------------

test('agentLinkHeader advertises catalog, spec, docs, and llms.txt with registered rels', () => {
  const link = agentLinkHeader(ORIGIN);
  assert.ok(link.includes(`<${ORIGIN}/.well-known/api-catalog>; rel="api-catalog"`));
  assert.ok(link.includes(`<${ORIGIN}/api/openapi.json>; rel="service-desc"`));
  assert.ok(link.includes(`<${ORIGIN}/api/docs>; rel="service-doc"`));
  assert.ok(link.includes(`<${ORIGIN}/llms.txt>; rel="describedby"`));
});

// --- robots.txt ------------------------------------------------------------------

test('robotsTxt declares Content Signals and the sitemap', () => {
  const body = robotsTxt(ORIGIN);
  assert.ok(body.includes('Content-Signal: ai-train=yes, search=yes, ai-input=yes'));
  assert.ok(body.includes(`Sitemap: ${ORIGIN}/sitemap.xml`));
  assert.ok(body.includes('User-agent: *\nAllow: /'));
});
