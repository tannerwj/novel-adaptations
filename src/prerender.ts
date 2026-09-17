// src/prerender.ts — bot-aware prerendering for SEO + social link unfurls.
//
// The SPA serves an identical shell on every page route, so crawlers and
// link-unfurlers see a generic title and no per-page content. For requests
// whose User-Agent looks like a crawler, we serve a lightweight static HTML
// document with the correct <title>, meta description, canonical URL, and
// Open Graph + Twitter Card tags (poster art for detail pages) built from D1.
// Real browsers are unaffected: they always get the SPA shell.
//
// Minimal by design: only public content routes are prerendered; auth/admin
// and unknown routes fall through to the shell (prerender() returns null).
// Prerendered documents are cached at the edge via the Cache API with
// s-maxage ~1h. Fail-soft: any error falls through to the shell.

import { getAdaptationSummaryBySlug, getBookBySlug, getScreenWorkBySlug } from './db';
import { getListBySlug } from './lists/db';
import { DEFAULT_DESCRIPTION } from './seo';

// ---------------------------------------------------------------------------
// Crawler detection
// ---------------------------------------------------------------------------

/**
 * Standard crawler/bot/unfurler User-Agent list: search indexers, social
 * preview fetchers, and messaging-app unfurlers. Case-insensitive substring
 * match — deliberately broad; a false positive only costs the bot a static
 * page (never user data), while a false negative just serves the shell.
 */
const BOT_UA_RE =
  /bot|crawler|spider|crawling|slurp|mediapartners-google|baidu|yandex|duckduck|sogou|exabot|facebot|ia_archiver|googlebot|google-inspectiontool|googleother|bingbot|bingpreview|twitterbot|facebookexternalhit|slackbot|linkedinbot|discordbot|whatsapp|telegrambot|telegram|pinterestbot|applebot|embedly|quora|tumblr|redditbot|vkshare|skypeuripreview|nuzzel|bitlybot|iframely|developers\.google\.com\/web\/snippet/i;

/** True when the User-Agent header belongs to a crawler/unfurler. */
export function isCrawler(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false;
  return BOT_UA_RE.test(userAgent);
}

// ---------------------------------------------------------------------------
// HTML building
// ---------------------------------------------------------------------------

/** Minimal HTML escaping for text content and attribute values. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface PrerenderMeta {
  /** Full <title> text. */
  title: string;
  description: string;
  /** Absolute canonical URL. */
  canonical: string;
  /** Absolute OG/Twitter image URL (falls back to the site favicon). */
  image: string;
  /** Small HTML body: h1 + summary + links. Keep it light. */
  body: string;
}

const SITE_NAME = 'Novel Adaptations';

/**
 * Render a complete, minimal, valid prerendered document. No app JS, no
 * session data, no secrets — safe to cache at the edge and serve to bots.
 */
export function prerenderDoc(meta: PrerenderMeta): string {
  const { title, description, canonical, image, body } = meta;
  const t = esc(title);
  const d = esc(description);
  return (
    `<!DOCTYPE html>` +
    `<html lang="en">` +
    `<head>` +
    `<meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${t}</title>` +
    `<meta name="description" content="${d}">` +
    `<link rel="canonical" href="${esc(canonical)}">` +
    `<meta property="og:site_name" content="${SITE_NAME}">` +
    `<meta property="og:type" content="website">` +
    `<meta property="og:title" content="${t}">` +
    `<meta property="og:description" content="${d}">` +
    `<meta property="og:url" content="${esc(canonical)}">` +
    `<meta property="og:image" content="${esc(image)}">` +
    `<meta name="twitter:card" content="summary_large_image">` +
    `<meta name="twitter:title" content="${t}">` +
    `<meta name="twitter:description" content="${d}">` +
    `<meta name="twitter:image" content="${esc(image)}">` +
    `</head>` +
    `<body>${body}</body>` +
    `</html>`
  );
}

const STATUS_LABEL: Record<string, string> = {
  rumored: 'Rumored',
  optioned: 'Optioned',
  in_development: 'In development',
  filming: 'Filming',
  post_production: 'Post-production',
  released: 'Released',
  cancelled: 'Cancelled',
};

const kindLabel = (kind: string): string => (kind === 'series' ? 'TV series' : 'Film');
const yearOf = (d: string | null): string | null =>
  d && /^\d{4}/.test(d) ? d.slice(0, 4) : null;

/** Poster/backdrop for OG image: prefer the stored art, else the favicon fallback. */
function artOrFallback(origin: string, ...urls: (string | null)[]): string {
  for (const u of urls) {
    if (u && /^https?:\/\//.test(u)) return u;
  }
  return `${origin}/og-card.jpg`;
}

// ---------------------------------------------------------------------------
// Per-route content
// ---------------------------------------------------------------------------

interface Prerendered {
  status: number;
  html: string;
}

/** Static (non-DB) routes with their prerender copy. */
const STATIC_ROUTES: Record<string, { title: string; description: string; body: string }> = {
  '/': {
    title: 'Novel Adaptations — every book’s journey to the screen',
    description: DEFAULT_DESCRIPTION,
    body:
      `<h1>Novel Adaptations</h1>` +
      `<p>${esc(DEFAULT_DESCRIPTION)}</p>` +
      `<p><a href="/calendar">Release calendar</a> · <a href="/most-wanted">Most wanted</a> · <a href="/lists">Lists</a></p>`,
  },
  '/calendar': {
    title: 'Release calendar — Novel Adaptations',
    description:
      'Upcoming book-to-screen releases: films and TV series adapted from novels, with release dates.',
    body:
      `<h1>Release calendar</h1>` +
      `<p>Upcoming book-to-screen releases: films and TV series adapted from novels, with release dates.</p>`,
  },
  '/most-wanted': {
    title: 'Most wanted adaptations — Novel Adaptations',
    description:
      'The book adaptations readers want most — vote for the stories you want to see on screen.',
    body:
      `<h1>Most wanted</h1>` +
      `<p>The book adaptations readers want most — vote for the stories you want to see on screen.</p>`,
  },
  '/search': {
    title: 'Search — Novel Adaptations',
    description: 'Search books, films, and TV series adapted from novels.',
    body:
      `<h1>Search</h1>` +
      `<p>Search books, films, and TV series adapted from novels.</p>`,
  },
  '/lists': {
    title: 'Lists — Novel Adaptations',
    description: 'Shareable lists of book adaptations, made by readers.',
    body:
      `<h1>Lists</h1>` +
      `<p>Shareable lists of book adaptations, made by readers.</p>`,
  },
  '/shelves': {
    title: 'Shelves — Novel Adaptations',
    description: 'Organize the adaptations you want to watch, are watching, or finished.',
    body:
      `<h1>Shelves</h1>` +
      `<p>Organize the adaptations you want to watch, are watching, or finished.</p>`,
  },
  '/feedback': {
    title: 'Feedback — Novel Adaptations',
    description: 'Suggest a book adaptation we’re missing or report a correction.',
    body:
      `<h1>Feedback</h1>` +
      `<p>Suggest a book adaptation we’re missing or report a correction.</p>`,
  },
  '/privacy': {
    title: 'Privacy Policy — Novel Adaptations',
    description: 'How Novel Adaptations collects, uses, and protects your data.',
    body:
      `<h1>Privacy Policy</h1>` +
      `<p>How Novel Adaptations collects, uses, and protects your data.</p>`,
  },
  '/terms': {
    title: 'Terms of Service — Novel Adaptations',
    description: 'The rules for using Novel Adaptations.',
    body:
      `<h1>Terms of Service</h1>` +
      `<p>The rules for using Novel Adaptations.</p>`,
  },
};

function staticRoute(path: string, origin: string): Prerendered {
  const r = STATIC_ROUTES[path]!;
  return {
    status: 200,
    html: prerenderDoc({
      title: r.title,
      description: r.description,
      canonical: origin + path,
      image: `${origin}/og-card.jpg`,
      body: r.body,
    }),
  };
}

async function watchRoute(db: D1Database, origin: string, slug: string): Promise<Prerendered | null> {
  const w = await getScreenWorkBySlug(db, slug);
  if (!w) return null;
  const year = yearOf(w.release_date);
  const title = `${w.title}${year ? ` (${year})` : ''} — Novel Adaptations`;
  const bookBits = w.books.map((b) => `${b.title} by ${b.authors}`);
  const description =
    `${w.title} (${kindLabel(w.kind)})` +
    (year ? `, released ${year}` : w.release_date ? '' : ', release date TBA') +
    (bookBits.length ? ` — adapted from ${bookBits.slice(0, 3).join('; ')}.` : '.');
  const body =
    `<h1>${esc(w.title)}</h1>` +
    `<p>${esc(description)}</p>` +
    (w.poster_url
      ? `<img src="${esc(w.poster_url)}" alt="${esc(w.title)} poster artwork" width="500">`
      : '') +
    (w.adaptations.length
      ? `<h2>Adaptations</h2><ul>${w.adaptations
          .map((a) => `<li><a href="/adaptations/${a.slug ?? a.id}">${esc(a.title)}</a> — ${esc(STATUS_LABEL[a.status] ?? a.status)}</li>`)
          .join('')}</ul>`
      : '');
  return {
    status: 200,
    html: prerenderDoc({
      title,
      description,
      canonical: `${origin}/watch/${w.slug ?? w.id}`,
      image: artOrFallback(origin, w.poster_url, w.backdrop_url),
      body,
    }),
  };
}

async function adaptationRoute(db: D1Database, origin: string, slug: string): Promise<Prerendered | null> {
  const a = await getAdaptationSummaryBySlug(db, slug);
  if (!a) return null;
  const year = yearOf(a.screen_release_date);
  const title = `${a.screen_title}: ${a.book_title} adaptation — Novel Adaptations`;
  const status = STATUS_LABEL[a.status] ?? a.status;
  const description =
    `${a.screen_title} (${kindLabel(a.screen_kind)}${year ? `, ${year}` : ''})` +
    ` — the ${status.toLowerCase()} adaptation of ${a.book_title} by ${a.book_authors}.`;
  const body =
    `<h1>${esc(a.screen_title)}</h1>` +
    `<p>${esc(description)}</p>` +
    ((a.screen_poster_url ?? a.book_cover_url)
      ? `<img src="${esc((a.screen_poster_url ?? a.book_cover_url)!)}" alt="${esc(a.screen_title)} artwork" width="500">`
      : '') +
    `<p>Status: ${esc(status)}</p>` +
    `<p><a href="/books/${a.book_slug ?? a.book_id}">${esc(a.book_title)}</a> · <a href="/watch/${a.screen_slug ?? a.screen_work_id}">${esc(a.screen_title)}</a></p>`;
  return {
    status: 200,
    html: prerenderDoc({
      title,
      description,
      canonical: `${origin}/adaptations/${a.adaptation_slug ?? a.id}`,
      image: artOrFallback(origin, a.screen_poster_url, a.book_cover_url),
      body,
    }),
  };
}

async function bookRoute(db: D1Database, origin: string, slug: string): Promise<Prerendered | null> {
  const b = await getBookBySlug(db, slug);
  if (!b) return null;
  const title = `${b.title} by ${b.authors} — Novel Adaptations`;
  const description = `${b.title} by ${b.authors}${b.pub_date ? ` (${yearOf(b.pub_date) ?? b.pub_date})` : ''} — see its film and TV adaptations.`;
  const body =
    `<h1>${esc(b.title)}</h1>` +
    `<p>${esc(description)}</p>` +
    (b.cover_url
      ? `<img src="${esc(b.cover_url)}" alt="${esc(b.title)} book cover" width="500">`
      : '');
  return {
    status: 200,
    html: prerenderDoc({
      title,
      description,
      canonical: `${origin}/books/${b.slug ?? b.id}`,
      image: artOrFallback(origin, b.cover_url),
      body,
    }),
  };
}

async function listRoute(db: D1Database, origin: string, slug: string): Promise<Prerendered | null> {
  const l = await getListBySlug(db, slug);
  // Private lists are never prerendered — the shell (and its auth gate)
  // decides what a visitor may see.
  if (!l || !l.is_public) return null;
  const title = `${l.title} — Novel Adaptations`;
  const description = l.description?.trim() || `A shareable list of book adaptations: ${l.title}.`;
  const body =
    `<h1>${esc(l.title)}</h1>` +
    `<p>${esc(description)}</p>`;
  return {
    status: 200,
    html: prerenderDoc({
      title,
      description,
      canonical: `${origin}/lists/${esc(l.slug)}`,
      image: `${origin}/og-card.jpg`,
      body,
    }),
  };
}

const ID_RE = /^[1-9]\d{0,9}$/;

/**
 * Build the prerendered document for a page-route path, or null when the
 * path isn't prerenderable (auth/admin/unknown/static-asset) or the ID
 * doesn't exist — the caller falls through to the SPA shell.
 */
export async function prerender(
  db: D1Database,
  origin: string,
  path: string,
): Promise<Prerendered | null> {
  if (Object.hasOwn(STATIC_ROUTES, path)) return staticRoute(path, origin);

  let m: RegExpMatchArray | null;
  if ((m = /^\/watch\/([^/]+)$/.exec(path))) {
    if (ID_RE.test(m[1]!)) return null; // numeric → the page route 301s to the slug
    return watchRoute(db, origin, decodeURIComponent(m[1]!));
  }
  if ((m = /^\/adaptations\/([^/]+)$/.exec(path))) {
    if (ID_RE.test(m[1]!)) return null;
    return adaptationRoute(db, origin, decodeURIComponent(m[1]!));
  }
  if ((m = /^\/books\/([^/]+)$/.exec(path))) {
    if (ID_RE.test(m[1]!)) return null;
    return bookRoute(db, origin, decodeURIComponent(m[1]!));
  }
  if ((m = /^\/lists\/([^/]+)$/.exec(path))) {
    return listRoute(db, origin, decodeURIComponent(m[1]!));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Edge caching
// ---------------------------------------------------------------------------

/**
 * Cache-Control for prerendered documents: public, stale-while-revalidate
 * semantics via s-maxage ~1h. Content changes (new posters, dates) propagate
 * within the hour; detail pages are cheap to rebuild on a miss.
 */
export const PRERENDER_S_MAXAGE = 3600;

function cacheKeyFor(url: string): Request {
  // A synthetic keyed request so prerendered HTML can never collide with a
  // real user's cached response for the same URL.
  const sep = url.includes('?') ? '&' : '?';
  return new Request(`${url}${sep}na-prerender=1`);
}

/**
 * Drop the cached bot preview for a list after it is edited, privatized, or
 * deleted. Without this, a previously public list's title and description
 * stay servable from the edge cache for up to PRERENDER_S_MAXAGE after the
 * change. Best-effort: the entry expires on its own within the hour anyway.
 */
export async function purgeListPreview(origin: string, slug: string): Promise<void> {
  try {
    await caches.default.delete(cacheKeyFor(`${origin}/lists/${slug}`));
  } catch {
    // ignore — cache purge must never fail the API request
  }
}

/**
 * Serve the prerendered document for a crawler request, from the edge cache
 * when available. Returns null when the path isn't prerenderable or anything
 * fails — the caller must fall through to the SPA shell.
 */
export async function servePrerendered(
  db: D1Database,
  url: string,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<Response | null> {
  const parsed = new URL(url);
  const origin = parsed.origin;
  const canonical = origin + parsed.pathname;
  try {
    const cache = caches.default;
    const key = cacheKeyFor(canonical);
    let res = await cache.match(key);
    if (!res) {
      const page = await prerender(db, origin, parsed.pathname);
      if (!page) return null;
      res = new Response(page.html, {
        status: page.status,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': `public, s-maxage=${PRERENDER_S_MAXAGE}`,
          'X-NA-Prerender': 'bot',
        },
      });
      waitUntil(cache.put(key, res.clone()));
    }
    return res;
  } catch {
    return null; // Cache API or D1 hiccup → shell, never a 500 for a bot.
  }
}
