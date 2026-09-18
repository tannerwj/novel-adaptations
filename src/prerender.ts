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

import { getAdaptationSummaryBySlug, getBookBySlug, getScreenWorkBySlug, parseCastJson } from './db';
import { getListBySlug } from './lists/db';
import { getMostWanted } from './votes/db';
import { DEFAULT_DESCRIPTION } from './seo';

// ---------------------------------------------------------------------------
// Crawler detection
// ---------------------------------------------------------------------------

/**
 * Standard crawler/bot/unfurler User-Agent list: search indexers, social
 * preview fetchers, messaging-app unfurlers, and AI training/inference
 * crawlers (GPTBot, ClaudeBot, Google-Extended, PerplexityBot, ...).
 * Case-insensitive substring match — deliberately broad; a false positive
 * only costs the bot a static page (never user data), while a false negative
 * just serves the shell.
 */
const BOT_UA_RE =
  /bot|crawler|spider|crawling|slurp|mediapartners-google|baidu|yandex|duckduck|sogou|exabot|facebot|ia_archiver|googlebot|google-inspectiontool|googleother|google-extended|bingbot|bingpreview|twitterbot|facebookexternalhit|slackbot|linkedinbot|discordbot|whatsapp|telegrambot|telegram|pinterestbot|applebot|embedly|quora|tumblr|redditbot|vkshare|skypeuripreview|nuzzel|bitlybot|iframely|anthropic-ai|claude-web|cohere-ai|developers\.google\.com\/web\/snippet/i;

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
  /**
   * Optional schema.org entity for a JSON-LD script tag — lets search and AI
   * engines parse the page as typed data (Movie/TVSeries/Book/WebSite).
   * Must be JSON-serializable; `<` is escaped on render so a hostile title
   * can't break out of the script tag.
   */
  jsonLd?: unknown;
  /** Cached YouTube trailer key → og:video tags for richer social unfurls. */
  video?: { embedUrl: string };
}

/** YouTube embed URL for a cached trailer key. */
export function youtubeEmbedUrl(youtubeKey: string): string {
  return `https://www.youtube.com/embed/${youtubeKey}`;
}

/** Serialize JSON-LD for inline <script>: escape `<` to block `</script>` breakout. */
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

const SITE_NAME = 'Novel Adaptations';

/**
 * Render a complete, minimal, valid prerendered document. No app JS, no
 * session data, no secrets — safe to cache at the edge and serve to bots.
 */
export function prerenderDoc(meta: PrerenderMeta): string {
  const { title, description, canonical, image, body, jsonLd, video } = meta;
  const t = esc(title);
  const d = esc(description);
  const origin = new URL(canonical).origin;
  return (
    `<!DOCTYPE html>` +
    `<html lang="en">` +
    `<head>` +
    `<meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    // Large image previews in search results — this is a visual catalog.
    `<meta name="robots" content="max-image-preview:large">` +
    `<title>${t}</title>` +
    `<meta name="description" content="${d}">` +
    `<link rel="canonical" href="${esc(canonical)}">` +
    `<link rel="alternate" type="application/rss+xml" title="Novel Adaptations — adaptation news" href="${esc(origin)}/feed.xml">` +
    `<meta property="og:site_name" content="${SITE_NAME}">` +
    `<meta property="og:type" content="website">` +
    `<meta property="og:title" content="${t}">` +
    `<meta property="og:description" content="${d}">` +
    `<meta property="og:url" content="${esc(canonical)}">` +
    `<meta property="og:image" content="${esc(image)}">` +
    (video
      ? `<meta property="og:video" content="${esc(video.embedUrl)}">` +
        `<meta property="og:video:type" content="text/html">`
      : '') +
    `<meta name="twitter:card" content="summary_large_image">` +
    `<meta name="twitter:title" content="${t}">` +
    `<meta name="twitter:description" content="${d}">` +
    `<meta name="twitter:image" content="${esc(image)}">` +
    (jsonLd !== undefined
      ? `<script type="application/ld+json">${serializeJsonLd(jsonLd)}</script>`
      : '') +
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
// JSON-LD (schema.org) — GEO: typed entities for search + AI engines
// ---------------------------------------------------------------------------

const SCHEMA_CONTEXT = 'https://schema.org';

export interface JsonLdBookRef {
  title: string;
  authors: string;
}

function bookRefJsonLd(b: JsonLdBookRef): Record<string, unknown> {
  return { '@type': 'Book', name: b.title, author: b.authors };
}

export interface ScreenWorkJsonLdInput {
  title: string;
  kind: string;
  releaseDate: string | null;
  description: string;
  canonical: string;
  image: string;
  books: JsonLdBookRef[];
  /**
   * Crowd rating from the site's own 1–5 ratings. Emitted as AggregateRating
   * only when count > 0 — Google renders star snippets for Movie/TVSeries.
   * The ratings are visible on the page (the rating widget), per guidelines.
   */
  rating?: { average: number; count: number };
  /** TMDB id → sameAs link so search engines disambiguate the title. */
  tmdbId?: number | null;
  /** Cast names (top-billed), emitted as actor Person nodes. */
  cast?: string[];
  /** Film director name, emitted as a director Person node. */
  director?: string | null;
}

/** Add an AggregateRating node to an entity when the crowd has actually rated it. */
function withAggregateRating(
  entity: Record<string, unknown>,
  rating: { average: number; count: number } | undefined,
): void {
  if (!rating || rating.count <= 0) return;
  entity.aggregateRating = {
    '@type': 'AggregateRating',
    ratingValue: rating.average,
    ratingCount: rating.count,
    bestRating: 5,
    worstRating: 1,
  };
}

/** Movie/TVSeries entity with isBasedOn → Book links. */
export function screenWorkJsonLd(input: ScreenWorkJsonLdInput): Record<string, unknown> {
  const entity: Record<string, unknown> = {
    '@context': SCHEMA_CONTEXT,
    '@type': input.kind === 'series' ? 'TVSeries' : 'Movie',
    name: input.title,
    url: input.canonical,
    image: input.image,
    description: input.description,
  };
  if (input.releaseDate && /^\d{4}-\d{2}-\d{2}/.test(input.releaseDate)) {
    entity.datePublished = input.releaseDate.slice(0, 10);
  }
  if (input.books.length > 0) {
    entity.isBasedOn = input.books.map(bookRefJsonLd);
  }
  withAggregateRating(entity, input.rating);
  if (input.tmdbId) {
    entity.sameAs = `https://www.themoviedb.org/${input.kind === 'series' ? 'tv' : 'movie'}/${input.tmdbId}`;
  }
  if (input.cast && input.cast.length > 0) {
    entity.actor = input.cast.map((name) => ({ '@type': 'Person', name }));
  }
  if (input.director) {
    entity.director = { '@type': 'Person', name: input.director };
  }
  return entity;
}

export interface BookJsonLdInput {
  title: string;
  authors: string;
  pubDate: string | null;
  description: string | null;
  canonical: string;
  image: string;
  /** Open Library subjects, e.g. ["Science fiction", "Dystopias"]. */
  subjects: string[];
  /** Crowd rating from the site's own 1–5 ratings; see ScreenWorkJsonLdInput. */
  rating?: { average: number; count: number };
}

/** Book entity; genre comes from Open Library subjects when available. */
export function bookJsonLd(input: BookJsonLdInput): Record<string, unknown> {
  const entity: Record<string, unknown> = {
    '@context': SCHEMA_CONTEXT,
    '@type': 'Book',
    name: input.title,
    author: input.authors,
    url: input.canonical,
    image: input.image,
  };
  if (input.description) entity.description = input.description;
  if (input.pubDate && /^\d{4}/.test(input.pubDate)) {
    entity.datePublished = input.pubDate.slice(0, 10);
  }
  if (input.subjects.length > 0) entity.genre = input.subjects;
  withAggregateRating(entity, input.rating);
  return entity;
}

/** WebSite entity for the home page, with a SearchAction AI engines can use. */
export function websiteJsonLd(origin: string): Record<string, unknown> {
  return {
    '@context': SCHEMA_CONTEXT,
    '@type': 'WebSite',
    name: SITE_NAME,
    url: `${origin}/`,
    description: DEFAULT_DESCRIPTION,
    potentialAction: {
      '@type': 'SearchAction',
      target: `${origin}/search?q={query}`,
      'query-input': 'required name=query',
    },
  };
}

/**
 * BreadcrumbList for a detail page, e.g. Home → Films & TV → Dune: Part Two.
 * Google renders these as breadcrumbs in the SERP listing.
 */
export function breadcrumbListJsonLd(
  origin: string,
  trail: { name: string; path: string }[],
): Record<string, unknown> {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((t, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: t.name,
      item: `${origin}${t.path}`,
    })),
  };
}

export interface VideoObjectJsonLdInput {
  title: string;
  description: string;
  youtubeKey: string;
  uploadDate: string | null;
}

/**
 * VideoObject for a cached YouTube trailer — makes watch pages eligible for
 * video rich results. Thumbnail/embed URLs are derived from the key; no
 * network call needed.
 */
export function videoObjectJsonLd(input: VideoObjectJsonLdInput): Record<string, unknown> {
  const entity: Record<string, unknown> = {
    '@type': 'VideoObject',
    name: `${input.title} — Official Trailer`,
    description: input.description,
    thumbnailUrl: `https://i.ytimg.com/vi/${input.youtubeKey}/hqdefault.jpg`,
    embedUrl: youtubeEmbedUrl(input.youtubeKey),
    contentUrl: `https://www.youtube.com/watch?v=${input.youtubeKey}`,
  };
  if (input.uploadDate && /^\d{4}-\d{2}-\d{2}/.test(input.uploadDate)) {
    entity.uploadDate = input.uploadDate.slice(0, 10);
  }
  return entity;
}

/**
 * Combine schema.org nodes for a page's JSON-LD script tag. A single node is
 * returned unchanged (existing shape preserved); multiple nodes are wrapped
 * in a @graph with the shared @context hoisted. Undefined nodes are dropped.
 */
export function jsonLdGraph(
  ...nodes: (Record<string, unknown> | undefined)[]
): Record<string, unknown> | undefined {
  const present = nodes.filter((n): n is Record<string, unknown> => n !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return {
    '@context': SCHEMA_CONTEXT,
    '@graph': present.map((n) => {
      const { '@context': _dropped, ...rest } = n;
      return rest;
    }),
  };
}

/**
 * Crowd rating aggregate for a target, or {count: 0} when nobody rated it.
 * Kept as raw SQL here (not via src/ratings/db.ts) so this module stays
 * dependency-light; the query mirrors getRatingSummary exactly.
 */
async function ratingAggregate(
  db: D1Database,
  targetType: 'book' | 'screen_work',
  targetId: number,
): Promise<{ average: number; count: number }> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count, AVG(rating) AS average
         FROM ratings
        WHERE target_type = ?1 AND target_id = ?2`,
    )
    .bind(targetType, targetId)
    .first<{ count: number; average: number | null }>();
  const count = row?.count ?? 0;
  // Round to one decimal, matching the API's rating summary.
  const average = count === 0 ? 0 : Math.round((row?.average ?? 0) * 10) / 10;
  return { average, count };
}

/** Parse the books.subjects JSON column into a string array; [] on any failure. */
export function parseSubjects(subjects: string | null): string[] {
  if (!subjects) return [];
  try {
    const parsed: unknown = JSON.parse(subjects);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Per-route content
// ---------------------------------------------------------------------------

export interface Prerendered {
  status: number;
  html: string;
  /**
   * The content model the HTML was rendered from. Markdown negotiation
   * (src/agent.ts) renders from this instead of re-parsing the HTML, so the
   * two representations can never drift apart.
   */
  meta: PrerenderMeta;
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
  // NOTE: /calendar and /most-wanted are DB-backed (calendarRoute /
  // mostWantedRoute below) so their prerenders carry a real ItemList.
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
  const meta: PrerenderMeta = {
    title: r.title,
    description: r.description,
    canonical: origin + path,
    image: `${origin}/og-card.jpg`,
    body: r.body,
    // WebSite entity (with SearchAction) on the home page only.
    jsonLd: path === '/' ? websiteJsonLd(origin) : undefined,
  };
  return { status: 200, html: prerenderDoc(meta), meta };
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
    (w.synopsis ? `<p>${esc(w.synopsis)}</p>` : '') +
    (w.poster_url
      ? `<img src="${esc(w.poster_url)}" alt="${esc(w.title)} poster artwork" width="500">`
      : '') +
    (w.adaptations.length
      ? `<h2>Adaptations</h2><ul>${w.adaptations
          .map((a) => `<li><a href="/adaptations/${a.slug ?? a.id}">${esc(a.title)}</a> — ${esc(STATUS_LABEL[a.status] ?? a.status)}</li>`)
          .join('')}</ul>`
      : '');
  const meta: PrerenderMeta = {
    title,
    description,
    canonical: `${origin}/watch/${w.slug ?? w.id}`,
    image: artOrFallback(origin, w.poster_url, w.backdrop_url),
    body,
    video: w.trailer_youtube_key ? { embedUrl: youtubeEmbedUrl(w.trailer_youtube_key) } : undefined,
    jsonLd: jsonLdGraph(
      screenWorkJsonLd({
        title: w.title,
        kind: w.kind,
        releaseDate: w.release_date,
        description,
        canonical: `${origin}/watch/${w.slug ?? w.id}`,
        image: artOrFallback(origin, w.poster_url, w.backdrop_url),
        books: w.books.map((b) => ({ title: b.title, authors: b.authors })),
        rating: await ratingAggregate(db, 'screen_work', w.id),
        tmdbId: w.tmdb_id,
        cast: parseCastJson(w.cast_json).map((m) => m.name),
        director: w.director,
      }),
      // Trailer is cached in D1 (screen_works.trailer_youtube_key) — when
      // present the page is eligible for video rich results.
      w.trailer_youtube_key
        ? videoObjectJsonLd({
            title: w.title,
            description,
            youtubeKey: w.trailer_youtube_key,
            uploadDate: w.release_date,
          })
        : undefined,
      breadcrumbListJsonLd(origin, [
        { name: 'Home', path: '/' },
        { name: w.title, path: `/watch/${w.slug ?? w.id}` },
      ]),
    ),
  };
  return { status: 200, html: prerenderDoc(meta), meta };
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
  const meta: PrerenderMeta = {
    title,
    description,
    canonical: `${origin}/adaptations/${a.adaptation_slug ?? a.id}`,
    image: artOrFallback(origin, a.screen_poster_url, a.book_cover_url),
    body,
    jsonLd: jsonLdGraph(
      screenWorkJsonLd({
        title: a.screen_title,
        kind: a.screen_kind,
        releaseDate: a.screen_release_date,
        description,
        canonical: `${origin}/adaptations/${a.adaptation_slug ?? a.id}`,
        image: artOrFallback(origin, a.screen_poster_url, a.book_cover_url),
        books: [{ title: a.book_title, authors: a.book_authors }],
      }),
      breadcrumbListJsonLd(origin, [
        { name: 'Home', path: '/' },
        { name: a.screen_title, path: `/adaptations/${a.adaptation_slug ?? a.id}` },
      ]),
    ),
  };
  return { status: 200, html: prerenderDoc(meta), meta };
}

async function bookRoute(db: D1Database, origin: string, slug: string): Promise<Prerendered | null> {
  const b = await getBookBySlug(db, slug);
  if (!b) return null;
  const title = `${b.title} by ${b.authors} — Novel Adaptations`;
  const description = `${b.title} by ${b.authors}${b.pub_date ? ` (${yearOf(b.pub_date) ?? b.pub_date})` : ''} — see its film and TV adaptations.`;
  const body =
    `<h1>${esc(b.title)}</h1>` +
    `<p>${esc(description)}</p>` +
    (b.description ? `<p>${esc(b.description)}</p>` : '') +
    (b.cover_url
      ? `<img src="${esc(b.cover_url)}" alt="${esc(b.title)} book cover" width="500">`
      : '');
  const meta: PrerenderMeta = {
    title,
    description,
    canonical: `${origin}/books/${b.slug ?? b.id}`,
    image: artOrFallback(origin, b.cover_url),
    body,
    jsonLd: jsonLdGraph(
      bookJsonLd({
        title: b.title,
        authors: b.authors,
        pubDate: b.pub_date,
        description: b.description,
        canonical: `${origin}/books/${b.slug ?? b.id}`,
        image: artOrFallback(origin, b.cover_url),
        subjects: parseSubjects(b.subjects),
        rating: await ratingAggregate(db, 'book', b.id),
      }),
      breadcrumbListJsonLd(origin, [
        { name: 'Home', path: '/' },
        { name: b.title, path: `/books/${b.slug ?? b.id}` },
      ]),
    ),
  };
  return { status: 200, html: prerenderDoc(meta), meta };
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
  const meta: PrerenderMeta = {
    title,
    description,
    canonical: `${origin}/lists/${esc(l.slug)}`,
    image: `${origin}/og-card.jpg`,
    body,
  };
  return { status: 200, html: prerenderDoc(meta), meta };
}

/**
 * Most Wanted as a real ranked list: the top-voted books with their vote
 * counts, exposed as an ItemList so search engines parse the ranking.
 * Fail-soft like everything else here — an empty/erroring query still
 * returns the static copy rather than null.
 */
async function mostWantedRoute(db: D1Database, origin: string): Promise<Prerendered> {
  const title = 'Most wanted adaptations — Novel Adaptations';
  const description =
    'The book adaptations readers want most — vote for the stories you want to see on screen.';
  let rows: { slug: string | null; bookId: number; title: string; authors: string; votes: number }[] = [];
  try {
    rows = (await getMostWanted(db, null, 10)).map((r) => ({
      slug: r.slug,
      bookId: r.bookId,
      title: r.title,
      authors: r.authors,
      votes: r.votes,
    }));
  } catch {
    rows = [];
  }
  const body =
    `<h1>Most wanted</h1>` +
    `<p>${esc(description)}</p>` +
    (rows.length
      ? `<ol>${rows
          .map(
            (r) =>
              `<li><a href="/books/${r.slug ?? r.bookId}">${esc(r.title)}</a> by ${esc(r.authors)} — ${r.votes} vote${r.votes === 1 ? '' : 's'}</li>`,
          )
          .join('')}</ol>`
      : '');
  const meta: PrerenderMeta = {
    title,
    description,
    canonical: `${origin}/most-wanted`,
    image: `${origin}/og-card.jpg`,
    body,
    jsonLd:
      rows.length > 0
        ? {
            '@context': SCHEMA_CONTEXT,
            '@type': 'ItemList',
            name: 'Most wanted book adaptations',
            itemListElement: rows.map((r, i) => ({
              '@type': 'ListItem',
              position: i + 1,
              name: `${r.title} by ${r.authors}`,
              url: `${origin}/books/${r.slug ?? r.bookId}`,
            })),
          }
        : undefined,
  };
  return { status: 200, html: prerenderDoc(meta), meta };
}

/**
 * Release calendar as a real dated list: the next upcoming screen releases,
 * exposed as an ItemList. Undated (TBA) works are excluded — they aren't
 * calendar entries.
 */
async function calendarRoute(db: D1Database, origin: string): Promise<Prerendered> {
  const title = 'Release calendar — Novel Adaptations';
  const description =
    'Upcoming book-to-screen releases: films and TV series adapted from novels, with release dates.';
  let rows: { slug: string | null; id: number; title: string; kind: string; release_date: string }[] = [];
  try {
    const res = await db
      .prepare(
        `SELECT id, slug, title, kind, release_date
           FROM screen_works
          WHERE release_date >= date('now')
          ORDER BY release_date ASC
          LIMIT 10`,
      )
      .all<{ id: number; slug: string | null; title: string; kind: string; release_date: string }>();
    rows = res.results ?? [];
  } catch {
    rows = [];
  }
  const body =
    `<h1>Release calendar</h1>` +
    `<p>${esc(description)}</p>` +
    (rows.length
      ? `<ul>${rows
          .map(
            (r) =>
              `<li><a href="/watch/${r.slug ?? r.id}">${esc(r.title)}</a> (${kindLabel(r.kind)}) — ${esc(r.release_date.slice(0, 10))}</li>`,
          )
          .join('')}</ul>`
      : '');
  const meta: PrerenderMeta = {
    title,
    description,
    canonical: `${origin}/calendar`,
    image: `${origin}/og-card.jpg`,
    body,
    jsonLd:
      rows.length > 0
        ? {
            '@context': SCHEMA_CONTEXT,
            '@type': 'ItemList',
            name: 'Upcoming book-to-screen releases',
            itemListElement: rows.map((r, i) => ({
              '@type': 'ListItem',
              position: i + 1,
              name: `${r.title} (${kindLabel(r.kind)}, ${r.release_date.slice(0, 10)})`,
              url: `${origin}/watch/${r.slug ?? r.id}`,
            })),
          }
        : undefined,
  };
  return { status: 200, html: prerenderDoc(meta), meta };
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

  // DB-backed collection pages with real ItemList structured data.
  if (path === '/calendar') return calendarRoute(db, origin);
  if (path === '/most-wanted') return mostWantedRoute(db, origin);

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

/**
 * Bump this integer whenever the prerendered document shape changes
 * (JSON-LD schema, body content, meta tags) — it is part of the edge cache
 * key, so a deploy never serves stale bot previews from a previous shape.
 */
export const PRERENDER_CACHE_VERSION = 5;

function cacheKeyFor(url: string): Request {
  // A synthetic keyed request so prerendered HTML can never collide with a
  // real user's cached response for the same URL. The version segment is
  // bumped whenever the prerendered document shape changes (new JSON-LD,
  // new body content, ...) so a deploy never serves stale bot previews.
  const sep = url.includes('?') ? '&' : '?';
  return new Request(`${url}${sep}na-prerender=v${PRERENDER_CACHE_VERSION}`);
}

/**
 * Bump this integer whenever the Markdown document shape changes — it is
 * part of the Markdown edge cache key (src/agent.ts serves it), so a deploy
 * never serves stale Markdown from a previous shape. Lives here next to
 * cacheKeyFor so purgeListPreview can drop both variants of a page.
 */
export const MARKDOWN_CACHE_VERSION = 3;

/** Edge cache key for the Markdown rendering of a page (served by src/agent.ts). */
export function markdownCacheKeyFor(url: string): Request {
  const sep = url.includes('?') ? '&' : '?';
  return new Request(`${url}${sep}na-markdown=v${MARKDOWN_CACHE_VERSION}`);
}

/**
 * Drop the cached bot preview for a list after it is edited, privatized, or
 * deleted — both the HTML and the Markdown variants, since both render from
 * the same title/description. Without this, a previously public list's title
 * and description stay servable from the edge cache for up to
 * PRERENDER_S_MAXAGE after the change. Best-effort: entries expire on their
 * own within the hour anyway.
 */
export async function purgeListPreview(origin: string, slug: string): Promise<void> {
  try {
    const cache = caches.default;
    const pageUrl = `${origin}/lists/${slug}`;
    await Promise.all([
      cache.delete(cacheKeyFor(pageUrl)),
      cache.delete(markdownCacheKeyFor(pageUrl)),
    ]);
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
          // The same URL can serve HTML or Markdown depending on the Accept
          // header (src/agent.ts) — caches must key on it.
          Vary: 'Accept',
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
