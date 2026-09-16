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
  /** Path portion of the canonical URL, e.g. `/watch/12`. Defaults to `/`. */
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
    .prepare('SELECT id FROM books ORDER BY id ASC')
    .all<{ id: number }>();
  for (const b of books ?? []) {
    entries.push({ loc: `${origin}/books/${b.id}` });
  }

  const { results: works } = await db
    .prepare('SELECT id, release_date FROM screen_works ORDER BY id ASC')
    .all<{ id: number; release_date: string | null }>();
  for (const w of works ?? []) {
    entries.push({
      loc: `${origin}/watch/${w.id}`,
      // Keep the date-only form Google prefers; release_date is YYYY-MM-DD.
      lastmod: w.release_date ? w.release_date.slice(0, 10) : undefined,
    });
  }

  const { results: adaptations } = await db
    .prepare('SELECT id FROM adaptations ORDER BY id ASC')
    .all<{ id: number }>();
  for (const a of adaptations ?? []) {
    entries.push({ loc: `${origin}/adaptations/${a.id}` });
  }

  return entries;
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
    const body = `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`;
    return c.text(body, 200, { 'Content-Type': 'text/plain' });
  });
}
