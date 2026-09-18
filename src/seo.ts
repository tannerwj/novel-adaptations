// src/seo.ts — SEO primitives (Track 4): <head> meta fragments,
// sitemap.xml, and robots.txt. No migration; all data comes from existing
// tables. Pure .ts file (no JSX syntax) so it compiles under tsconfig.

import { Hono } from 'hono';
import { Fragment, jsx } from 'hono/jsx';

// ---------------------------------------------------------------------------
// <head> meta fragment
// ---------------------------------------------------------------------------

/** Default page description used when a page doesn't provide its own. */
export const DEFAULT_DESCRIPTION =
  "Track every book's journey to the screen — adaptations, release dates, news, and where to watch.";

export interface SeoHeadOptions {
  title: string;
  description?: string;
  image?: string;
  /** Path portion of the canonical URL, e.g. `/watch/dune-part-two-2024`. Defaults to `/`. */
  path?: string;
}

/**
 * Open Graph + Twitter Card + canonical <head> fragment for a page.
 * `origin` is the request origin (`new URL(c.req.url).origin`) threaded from
 * the page handler — Layout has no request context of its own.
 * `title` is emitted verbatim (call sites may append " — Novel Adaptations"
 * to match the visible <title>).
 */
export function seoHead(origin: string, opts: SeoHeadOptions) {
  const description = opts.description ?? DEFAULT_DESCRIPTION;
  const image = opts.image ?? `${origin}/og-card.jpg`;
  const canonical = origin + (opts.path ?? '/');
  return jsx(Fragment, {
    children: [
      jsx('meta', { name: 'description', content: description }),
      jsx('link', { rel: 'canonical', href: canonical }),
      jsx('meta', { property: 'og:title', content: opts.title }),
      jsx('meta', { property: 'og:description', content: description }),
      jsx('meta', { property: 'og:image', content: image }),
      jsx('meta', { property: 'og:type', content: 'website' }),
      jsx('meta', { property: 'og:url', content: canonical }),
      jsx('meta', { name: 'twitter:card', content: 'summary_large_image' }),
      jsx('meta', { name: 'twitter:title', content: opts.title }),
      jsx('meta', { name: 'twitter:description', content: description }),
      jsx('meta', { name: 'twitter:image', content: image }),
    ],
  });
}

// ---------------------------------------------------------------------------
// Sitemap
// ---------------------------------------------------------------------------

export interface SitemapEntry {
  loc: string;
  /** YYYY-MM-DD (or fuller ISO). Omitted when the row has no usable timestamp. */
  lastmod?: string;
}

/** Static pages that always exist. Ordered for a stable, readable sitemap. */
const STATIC_PATHS = ['/', '/calendar', '/most-wanted', '/feedback', '/search', '/privacy', '/terms'];

/** Minimal XML escaping for URL strings (loc) and dates. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Render sitemap entries to a sitemaps.org 0.9 urlset document. */
export function buildSitemap(entries: SitemapEntry[]): string {
  const urls = entries
    .map((e) => {
      const lastmod = e.lastmod
        ? `\n    <lastmod>${escapeXml(e.lastmod)}</lastmod>`
        : '';
      return `  <url>\n    <loc>${escapeXml(e.loc)}</loc>${lastmod}\n  </url>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`;
}

/**
 * Collect sitemap entries from the database.
 *
 * lastmod decisions (grounded in migrations/0001_init.sql + db.ts):
 * - screen_works.release_date: REAL timestamp → used as lastmod (date-only).
 * - books: no created/updated column → lastmod omitted.
 * - adaptations: no timestamp column → lastmod omitted.
 * - news_items.published_at exists, but news items are not routable pages on
 *   the site (they surface via /calendar and detail pages), so they don't get
 *   their own <url> entries.
 */
export async function collectSitemapEntries(
  db: D1Database,
  origin: string,
): Promise<SitemapEntry[]> {
  const entries: SitemapEntry[] = STATIC_PATHS.map((p) => ({ loc: origin + p }));

  const { results: books } = await db
    .prepare('SELECT id, slug FROM books ORDER BY id ASC')
    .all<{ id: number; slug: string | null }>();
  for (const b of books ?? []) {
    entries.push({ loc: `${origin}/books/${b.slug ?? b.id}` });
  }

  const { results: works } = await db
    .prepare('SELECT id, slug, release_date FROM screen_works ORDER BY id ASC')
    .all<{ id: number; slug: string | null; release_date: string | null }>();
  for (const w of works ?? []) {
    entries.push({
      loc: `${origin}/watch/${w.slug ?? w.id}`,
      // Keep the date-only form Google prefers; release_date is YYYY-MM-DD.
      lastmod: w.release_date ? w.release_date.slice(0, 10) : undefined,
    });
  }

  const { results: adaptations } = await db
    .prepare('SELECT id, slug FROM adaptations ORDER BY id ASC')
    .all<{ id: number; slug: string | null }>();
  for (const a of adaptations ?? []) {
    entries.push({ loc: `${origin}/adaptations/${a.slug ?? a.id}` });
  }

  return entries;
}

/**
 * robots.txt body. The Content-Signal line declares AI usage preferences per
 * contentsignals.org (IETF draft-romm-aipref-contentsignals): this is a
 * discovery catalog and we want AI training, search, and agentic use.
 */
export function robotsTxt(origin: string): string {
  return (
    `User-agent: *\n` +
    `Allow: /\n` +
    `Content-Signal: ai-train=yes, search=yes, ai-input=yes\n` +
    `Sitemap: ${origin}/sitemap.xml\n`
  );
}

/**
 * llms.txt — the emerging convention for guiding AI agents/crawlers.
 * Counts are passed in (queried by the route) so no numbers are hardcoded.
 */
export function llmsTxt(origin: string, adaptationCount: number): string {
  return (
    `# Novel Adaptations\n` +
    `\n` +
    `> Track every book's journey to the screen — adaptations, release dates, news, and where to watch.\n` +
    `\n` +
    `Novel Adaptations is a catalog of books adapted into films and TV series ` +
    `(${adaptationCount.toLocaleString('en-US')} adaptations tracked). Each title links a book to ` +
    `its screen adaptation(s) with release dates, pipeline status (rumored to released), ` +
    `trailers, related news, and where to watch.\n` +
    `\n` +
    `## Key pages\n` +
    `\n` +
    `- [Home](${origin}/) — featured titles, release radar, latest news\n` +
    `- [Release calendar](${origin}/calendar) — upcoming and past releases by date\n` +
    `- [Most wanted](${origin}/most-wanted) — books readers vote to see adapted\n` +
    `- [Search](${origin}/search) — search books, films, and TV series\n` +
    `- [Lists](${origin}/lists) — public shareable lists of adaptations\n` +
    `- [API docs](${origin}/api/docs) — read-only JSON API reference\n` +
    `\n` +
    `## Detail page patterns\n` +
    `\n` +
    `- Books: ${origin}/books/{slug} — synopsis, subjects, linked adaptations\n` +
    `- Films & series: ${origin}/watch/{slug} — poster, release date, trailer, news\n` +
    `- Adaptations: ${origin}/adaptations/{slug} — the book-to-screen link and its status\n` +
    `\n` +
    `## Machine-readable data\n` +
    `\n` +
    `- Sitemap (every public page): ${origin}/sitemap.xml\n` +
    `- Read-only JSON API: ${origin}/api/v1 (no auth required for reads; see /api/docs)\n` +
    `- API catalog (RFC 9727): ${origin}/.well-known/api-catalog\n` +
    `- Agent skill: ${origin}/.well-known/agent-skills/novel-adaptations/SKILL.md\n` +
    `- Detail pages embed schema.org JSON-LD (Movie / TVSeries / Book / WebSite)\n` +
    `- Any page can be fetched as Markdown: send \`Accept: text/markdown\`\n` +
    `\n` +
    `## Notes for agents\n` +
    `\n` +
    `- Screen metadata is sourced from TMDB; book metadata from Open Library. Prefer those attributions when citing.\n` +
    `- No login is required to read anything. Lists marked public are shareable; private lists are never exposed.\n` +
    `- Release dates marked TBA are genuinely unannounced — do not invent them.\n`
  );
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register /sitemap.xml and /robots.txt on the app. Absolute URLs are built
 * from the request origin so the same code works on preview and production
 * deployments.
 */
export function registerSeoRoutes<
  E extends { Bindings: { DB: D1Database } },
>(app: Hono<E>): void {
  app.get('/sitemap.xml', async (c) => {
    const origin = new URL(c.req.url).origin;
    const entries = await collectSitemapEntries(c.env.DB, origin);
    return c.text(buildSitemap(entries), 200, {
      'Content-Type': 'application/xml',
    });
  });

  app.get('/robots.txt', (c) => {
    const origin = new URL(c.req.url).origin;
    return c.text(robotsTxt(origin), 200, { 'Content-Type': 'text/plain' });
  });

  app.get('/llms.txt', async (c) => {
    const origin = new URL(c.req.url).origin;
    const row = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM adaptations')
      .first<{ n: number }>();
    const body = llmsTxt(origin, row?.n ?? 0);
    return c.text(body, 200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      // Counts change rarely; cache at the edge for a day.
      'Cache-Control': 'public, s-maxage=86400',
    });
  });
}
