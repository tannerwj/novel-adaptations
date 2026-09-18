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
  /** Absolute image URLs for Google's image extension (poster art, covers). */
  images?: string[];
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

/** Render sitemap entries to a sitemaps.org 0.9 urlset document, with Google's
 *  image extension for entries that carry poster/cover art. */
export function buildSitemap(entries: SitemapEntry[]): string {
  const hasImages = entries.some((e) => e.images && e.images.length > 0);
  const urls = entries
    .map((e) => {
      const lastmod = e.lastmod
        ? `\n    <lastmod>${escapeXml(e.lastmod)}</lastmod>`
        : '';
      const images = (e.images ?? [])
        .map((src) => `\n    <image:image>\n      <image:loc>${escapeXml(src)}</image:loc>\n    </image:image>`)
        .join('');
      return `  <url>\n    <loc>${escapeXml(e.loc)}</loc>${lastmod}${images}\n  </url>`;
    })
    .join('\n');
  const imageNs = hasImages
    ? ` xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${imageNs}>\n${urls}\n</urlset>`;
}

/** Google's image extension requires absolute URLs — relative art is dropped. */
function absImage(url: string | null): string[] {
  return url && /^https?:\/\//i.test(url) ? [url] : [];
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
    .prepare('SELECT id, slug, cover_url FROM books ORDER BY id ASC')
    .all<{ id: number; slug: string | null; cover_url: string | null }>();
  for (const b of books ?? []) {
    entries.push({
      loc: `${origin}/books/${b.slug ?? b.id}`,
      images: absImage(b.cover_url),
    });
  }

  const { results: works } = await db
    .prepare('SELECT id, slug, release_date, poster_url FROM screen_works ORDER BY id ASC')
    .all<{ id: number; slug: string | null; release_date: string | null; poster_url: string | null }>();
  for (const w of works ?? []) {
    entries.push({
      loc: `${origin}/watch/${w.slug ?? w.id}`,
      // Keep the date-only form Google prefers; release_date is YYYY-MM-DD.
      lastmod: w.release_date ? w.release_date.slice(0, 10) : undefined,
      images: absImage(w.poster_url),
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
    `- Release dates marked TBA are genuinely unannounced — do not invent them.\n` +
    `\n` +
    `## Feeds\n` +
    `\n` +
    `- Full catalog dump (every adaptation, one line each): ${origin}/llms-full.txt\n` +
    `- Adaptation news as RSS: ${origin}/feed.xml\n`
  );
}

// ---------------------------------------------------------------------------
// RSS feed — curated adaptation news, approved-only
// ---------------------------------------------------------------------------

export interface RssItem {
  title: string;
  link: string;
  description: string | null;
  /** ISO-ish timestamp from news_items.published_at; null → created_at fallback. */
  pubDate: string | null;
  source: string;
}

/** Normalize a D1 timestamp to an RFC 822 date string; '' when unusable. */
function rssPubDate(value: string | null): string {
  if (!value) return '';
  const d = new Date(value.includes('T') ? value : value.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? '' : d.toUTCString();
}

/** RSS 2.0 for the approved news queue — feed readers and agents alike. */
export function buildRssFeed(origin: string, items: RssItem[]): string {
  const xmlItems = items
    .map((it) => {
      const pubDate = rssPubDate(it.pubDate);
      return (
        `    <item>\n` +
        `      <title>${escapeXml(it.title)}</title>\n` +
        `      <link>${escapeXml(it.link)}</link>\n` +
        (it.description ? `      <description>${escapeXml(it.description)}</description>\n` : '') +
        (pubDate ? `      <pubDate>${pubDate}</pubDate>\n` : '') +
        `      <source>${escapeXml(it.source)}</source>\n` +
        `    </item>`
      );
    })
    .join('\n');
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<rss version="2.0">\n` +
    `  <channel>\n` +
    `    <title>Novel Adaptations — adaptation news</title>\n` +
    `    <link>${escapeXml(origin)}/</link>\n` +
    `    <description>Curated news about books becoming films and TV series.</description>\n` +
    `    <language>en-us</language>\n` +
    (xmlItems ? `\n${xmlItems}\n` : '') +
    `  </channel>\n` +
    `</rss>`
  );
}

// ---------------------------------------------------------------------------
// /llms-full.txt — the entire catalog in one agent-readable page
// ---------------------------------------------------------------------------

export interface FullCatalogRow {
  a_slug: string | null;
  a_id: number;
  status: string;
  book_title: string;
  authors: string;
  b_slug: string | null;
  b_id: number;
  screen_title: string;
  kind: string;
  release_date: string | null;
  s_slug: string | null;
  s_id: number;
}

/** One markdown line per adaptation — the whole catalog for agents that
 *  want everything without crawling thousands of pages. */
export function llmsFullTxt(origin: string, rows: FullCatalogRow[]): string {
  const lines = rows.map((r) => {
    const year = r.release_date && /^\d{4}/.test(r.release_date) ? r.release_date.slice(0, 4) : 'TBA';
    const kind = r.kind === 'series' ? 'TV series' : 'film';
    return (
      `- ${r.book_title} by ${r.authors} → ${r.screen_title} (${kind}, ${year}) — ${r.status}\n` +
      `  book: ${origin}/books/${r.b_slug ?? r.b_id} · screen: ${origin}/watch/${r.s_slug ?? r.s_id} · adaptation: ${origin}/adaptations/${r.a_slug ?? r.a_id}`
    );
  });
  return (
    `# Novel Adaptations — full catalog\n` +
    `\n` +
    `${rows.length.toLocaleString('en-US')} book-to-screen adaptations. ` +
    `For a guided overview see ${origin}/llms.txt.\n` +
    `\n` +
    lines.join('\n') +
    `\n`
  );
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register /sitemap.xml, /robots.txt, /llms.txt, /llms-full.txt, and /feed.xml
 * on the app. Absolute URLs are built from the request origin so the same
 * code works on preview and production deployments.
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

  app.get('/llms-full.txt', async (c) => {
    const origin = new URL(c.req.url).origin;
    const { results } = await c.env.DB
      .prepare(
        `SELECT a.slug AS a_slug, a.id AS a_id, a.status,
                b.title AS book_title, b.authors, b.slug AS b_slug, b.id AS b_id,
                s.title AS screen_title, s.kind, s.release_date,
                s.slug AS s_slug, s.id AS s_id
           FROM adaptations a
           JOIN books b ON b.id = a.book_id
           JOIN screen_works s ON s.id = a.screen_work_id
          ORDER BY a.id ASC`,
      )
      .all<FullCatalogRow>();
    return c.text(llmsFullTxt(origin, results ?? []), 200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      // Catalog-wide dump; counts change rarely — edge-cache for a day.
      'Cache-Control': 'public, s-maxage=86400',
    });
  });

  app.get('/feed.xml', async (c) => {
    const origin = new URL(c.req.url).origin;
    const { results } = await c.env.DB
      .prepare(
        `SELECT title, url, summary, source, published_at, created_at
           FROM news_items
          WHERE status = 'approved'
          ORDER BY published_at DESC NULLS LAST, id DESC
          LIMIT 50`,
      )
      .all<{
        title: string;
        url: string;
        summary: string | null;
        source: string;
        published_at: string | null;
        created_at: string | null;
      }>();
    const items: RssItem[] = (results ?? []).map((r) => ({
      title: r.title,
      link: r.url,
      description: r.summary,
      pubDate: r.published_at ?? r.created_at,
      source: r.source,
    }));
    return c.text(buildRssFeed(origin, items), 200, {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      // News turnover is slow; an hour of edge cache is plenty.
      'Cache-Control': 'public, s-maxage=3600',
    });
  });
}
