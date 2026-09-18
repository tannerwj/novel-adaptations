// src/agent.ts — Agent-readiness surface for Novel Adaptations.
//
// - Markdown content negotiation: `Accept: text/markdown` serves a clean
//   Markdown rendering of any prerenderable page. It renders from the same
//   PrerenderMeta content model as the bot HTML prerender (src/prerender.ts),
//   never a drifted copy. (Cloudflare's edge "Markdown for Agents" converter
//   is a Pro+ feature; this zone is on the Free plan, so the Worker negotiates
//   directly — same wire contract.)
// - RFC 9727 API catalog at /.well-known/api-catalog (linkset+json).
// - Agent Skills discovery index at /.well-known/agent-skills/index.json plus
//   the SKILL.md it points at (agentskills.io discovery RFC v0.2.0).
// - RFC 8288 Link header value advertising the machine-readable resources.
//
// Pure .ts (no JSX) so it compiles under tsconfig like seo.ts.

import { Hono } from 'hono';
import {
  PRERENDER_S_MAXAGE,
  markdownCacheKeyFor,
  prerender,
  type PrerenderMeta,
} from './prerender';

// ---------------------------------------------------------------------------
// Accept: text/markdown negotiation
// ---------------------------------------------------------------------------

/**
 * True when the Accept header explicitly asks for Markdown with q > 0.
 * A bare wildcard Accept on its own does not count — HTML stays the default.
 */
export function acceptsMarkdown(accept: string | null | undefined): boolean {
  if (!accept) return false;
  for (const part of accept.split(',')) {
    const [type, ...params] = part.split(';').map((s) => s.trim().toLowerCase());
    if (type !== 'text/markdown') continue;
    const q = params.find((p) => p.startsWith('q='));
    if (!q) return true;
    const v = parseFloat(q.slice(2));
    if (!Number.isNaN(v) && v > 0) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Prerender body HTML → Markdown
// ---------------------------------------------------------------------------

/**
 * Escape Markdown-significant punctuation inside plain text. Our prerender
 * bodies are generated HTML (all text HTML-escaped via esc()), so the input
 * domain is closed: headings, paragraphs, lists, links, images, and inline
 * emphasis only. Escaping runs on text nodes *before* tag conversion — a
 * backslash is literal in HTML text, so the HTML rendering is unaffected.
 */
function mdEscapeText(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|>:]/g, '\\$&');
}

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
};

/** Decode HTML entities (named + numeric) back to characters. */
function unesc(s: string): string {
  return s.replace(/&(#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code.startsWith('#')) {
      const cp = parseInt(code.slice(1), 10);
      return Number.isNaN(cp) ? m : String.fromCodePoint(cp);
    }
    return HTML_ENTITIES[m.toLowerCase()] ?? m;
  });
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, '');
}

/** Markdown-escape the text nodes of an HTML fragment (attributes untouched). */
function escapeTextNodes(html: string): string {
  return html.replace(/(^|>)([^<>]*)(<|$)/g, (_m, open: string, text: string, close: string) =>
    open + mdEscapeText(text) + close,
  );
}

/**
 * Convert a prerender body fragment to Markdown. Scoped to the tags our
 * bodies actually emit (h1-h3, p, ul/ol/li, a, img, br, strong/em); anything
 * else degrades to its text content rather than leaking markup.
 */
export function htmlToMarkdown(html: string, origin: string): string {
  let s = escapeTextNodes(html);

  s = s.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = /src="([^"]*)"/i.exec(tag)?.[1] ?? '';
    const alt = /alt="([^"]*)"/i.exec(tag)?.[1] ?? '';
    return `\n\n![${unesc(alt)}](${src})\n\n`;
  });
  s = s.replace(/<a\s+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) => {
    const url = href.startsWith('/') ? origin + href : href;
    return `[${unesc(stripTags(text))}](${url})`;
  });
  s = s.replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, (_m, _t: string, t: string) =>
    `**${unesc(stripTags(t))}**`,
  );
  s = s.replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, (_m, _t: string, t: string) =>
    `*${unesc(stripTags(t))}*`,
  );

  s = s.replace(/<h1>([\s\S]*?)<\/h1>/gi, (_m, t: string) => `\n\n# ${unesc(stripTags(t))}\n\n`);
  s = s.replace(/<h2>([\s\S]*?)<\/h2>/gi, (_m, t: string) => `\n\n## ${unesc(stripTags(t))}\n\n`);
  s = s.replace(/<h3>([\s\S]*?)<\/h3>/gi, (_m, t: string) => `\n\n### ${unesc(stripTags(t))}\n\n`);
  s = s.replace(/<li>([\s\S]*?)<\/li>/gi, (_m, t: string) => `\n- ${unesc(stripTags(t)).trim()}\n`);
  s = s.replace(/<\/?(ul|ol)>/gi, '\n');
  s = s.replace(/<p>([\s\S]*?)<\/p>/gi, (_m, t: string) => `\n\n${unesc(stripTags(t)).trim()}\n\n`);
  s = s.replace(/<br\s*\/?>/gi, '\n');

  s = stripTags(s);
  s = unesc(s);
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

/** Rough token estimate (~4 chars/token), same convention as Cloudflare's x-markdown-tokens. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** YAML double-quoted scalar via JSON stringification (valid for our titles). */
function yamlStr(s: string): string {
  return JSON.stringify(s);
}

/**
 * Render a full Markdown document from the prerender content model:
 * YAML frontmatter, the body as Markdown, then the page's schema.org JSON-LD
 * in a fenced block so agents get the typed entities too.
 */
export function prerenderToMarkdown(meta: PrerenderMeta, origin: string): string {
  const front =
    `---\ntitle: ${yamlStr(meta.title)}\ndescription: ${yamlStr(meta.description)}\n---\n`;
  const body = htmlToMarkdown(meta.body, origin);
  const jsonLd =
    meta.jsonLd !== undefined
      ? `\n\n\`\`\`json\n${JSON.stringify(meta.jsonLd, null, 2)}\n\`\`\`\n`
      : '';
  return `${front}\n${body}${jsonLd}`.trim() + '\n';
}

// ---------------------------------------------------------------------------
// Cached Markdown serving (mirrors servePrerendered's edge caching).
// The cache key builder and MARKDOWN_CACHE_VERSION live in src/prerender.ts
// next to their HTML siblings, so purgeListPreview can drop both variants.
// ---------------------------------------------------------------------------

/**
 * Serve the Markdown rendering of a page-route path, from the edge cache when
 * available. Returns null when the path isn't prerenderable — the caller
 * falls through to the normal HTML dispatch.
 */
export async function serveMarkdown(
  db: D1Database,
  url: string,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<Response | null> {
  const parsed = new URL(url);
  const origin = parsed.origin;
  const canonical = origin + parsed.pathname;
  try {
    const cache = caches.default;
    const key = markdownCacheKeyFor(canonical);
    let res = await cache.match(key);
    if (!res) {
      const page = await prerender(db, origin, parsed.pathname);
      if (!page) return null;
      const md = prerenderToMarkdown(page.meta, origin);
      res = new Response(md, {
        status: page.status,
        headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Cache-Control': `public, s-maxage=${PRERENDER_S_MAXAGE}`,
          // The same URL can serve HTML or Markdown depending on Accept.
          Vary: 'Accept',
          'x-markdown-tokens': String(estimateTokens(md)),
          'X-NA-Prerender': 'markdown',
        },
      });
      waitUntil(cache.put(key, res.clone()));
    }
    return res;
  } catch {
    return null; // Cache API or D1 hiccup → fall through to HTML, never a 500.
  }
}

// ---------------------------------------------------------------------------
// RFC 9727 API catalog
// ---------------------------------------------------------------------------

/** linkset+json catalog pointing agents at the real, read-only JSON API. */
export function apiCatalog(origin: string): Record<string, unknown> {
  return {
    linkset: [
      {
        anchor: `${origin}/`,
        'service-desc': [
          {
            href: `${origin}/api/openapi.json`,
            type: 'application/vnd.oai.openapi+json;version=3.1',
          },
        ],
        'service-doc': [{ href: `${origin}/api/docs` }],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Agent Skills discovery (agentskills.io discovery RFC v0.2.0)
// ---------------------------------------------------------------------------

const AGENT_SKILLS_SCHEMA = 'https://schemas.agentskills.io/discovery/0.2.0/schema.json';
const SKILL_NAME = 'novel-adaptations';
const SKILL_PATH = `/.well-known/agent-skills/${SKILL_NAME}/SKILL.md`;

const SKILL_MD_TEMPLATE = `# Novel Adaptations skill

Novel Adaptations ({origin}) tracks every book's journey to the screen: which
books became films or TV series, their release dates and pipeline status,
trailers, news, and where to watch.

## Read the catalog

- Start at {origin}/llms.txt for an overview, URL patterns, and data-source notes.
- Every public page is listed in {origin}/sitemap.xml.
- Any page can be fetched as Markdown: send \`Accept: text/markdown\`. The
  Markdown carries YAML frontmatter (title, description) and the page's
  schema.org JSON-LD in a fenced block.
- Machine API: read-only JSON at {origin}/api/v1 (no auth needed for reads).
  - OpenAPI 3.1: {origin}/api/openapi.json
  - Interactive docs: {origin}/api/docs
  - RFC 9727 catalog: {origin}/.well-known/api-catalog

## Page patterns

- Books: {origin}/books/{slug} — synopsis, subjects, linked adaptations
- Films & series: {origin}/watch/{slug} — release date, trailer, news, where to watch
- Adaptations: {origin}/adaptations/{slug} — the book-to-screen link and its status
- Release calendar: {origin}/calendar · Most wanted: {origin}/most-wanted

## Rules for agents

- Dates marked TBA are genuinely unannounced — never invent a release date.
- Screen metadata comes from TMDB; book metadata from Open Library. Attribute them when citing.
- No login is required to read anything. Only public lists are exposed; private lists never appear.
- Prefer the Markdown or JSON representations over scraping HTML — they are cheaper and stable.
`;

/** The SKILL.md artifact, with the request origin filled in. */
export function agentSkillMarkdown(origin: string): string {
  return SKILL_MD_TEMPLATE.replaceAll('{origin}', origin);
}

async function sha256Hex(text: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Discovery index; the digest is computed over the exact bytes served. */
export function agentSkillsIndex(origin: string, skillDigestHex: string): Record<string, unknown> {
  return {
    $schema: AGENT_SKILLS_SCHEMA,
    skills: [
      {
        name: SKILL_NAME,
        type: 'skill-md',
        description:
          'How AI agents can read Novel Adaptations: llms.txt, Markdown pages, sitemap, and the read-only JSON API.',
        url: `${origin}${SKILL_PATH}`,
        digest: `sha256:${skillDigestHex}`,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// RFC 8288 Link header for agent discovery
// ---------------------------------------------------------------------------

/** Link header value advertising the machine-readable resources (registered rels). */
export function agentLinkHeader(origin: string): string {
  return (
    `<${origin}/.well-known/api-catalog>; rel="api-catalog", ` +
    `<${origin}/api/openapi.json>; rel="service-desc", ` +
    `<${origin}/api/docs>; rel="service-doc", ` +
    `<${origin}/llms.txt>; rel="describedby"`
  );
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerAgentRoutes<E extends { Bindings: { DB: D1Database } }>(
  app: Hono<E>,
): void {
  app.get('/.well-known/api-catalog', (c) => {
    const origin = new URL(c.req.url).origin;
    return c.json(apiCatalog(origin), 200, {
      'Content-Type': 'application/linkset+json',
    });
  });

  app.get('/.well-known/agent-skills/index.json', async (c) => {
    const origin = new URL(c.req.url).origin;
    const digest = await sha256Hex(agentSkillMarkdown(origin));
    return c.json(agentSkillsIndex(origin, digest));
  });

  app.get(SKILL_PATH, (c) => {
    const origin = new URL(c.req.url).origin;
    return c.text(agentSkillMarkdown(origin), 200, {
      'Content-Type': 'text/markdown; charset=utf-8',
    });
  });
}
