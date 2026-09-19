// Phase 2+3 (SSR→SPA cutover): this worker now serves a single-page app.
//
// - Every bookmarkable page route serves the SPA shell (src/spa/shell.ts).
//   The client router (public/app.js) renders the page; ALL data and
//   mutations flow through the versioned JSON API at /api/v1 (docs/API.md).
// - All legacy server-rendered pages and unversioned /api/* endpoints are
//   retired. Their modules stay on disk only where src/api/v1.ts reuses
//   their helpers (db access, crypto, email); no legacy route is mounted.
// - Kept: /api/v1/*, sitemap.xml, robots.txt, favicons, the daily news
//   pipeline cron, and the scheduled() handler.

import { Hono, type Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { serveFavicon } from './favicon';
import { scheduledNewsRun } from './news/ingest';
import { runCreditsBatch } from './enrichment';
import {
  countTotalExpansion,
  hoursSinceLastScrape,
  processExpansionBatch,
  scrapeAndStoreExpansionCandidates,
} from './expansion';
import { registerSeoRoutes } from './seo';
import { registerIndexNowKeyRoute } from './indexnow';
import { registerIndexNowBulkRetryRoute } from './indexnow_bulk_retry';
// Versioned JSON API at /api/v1 — the SPA contract (docs/openapi.yaml).
import { mountV1 } from './api/v1';
import openapiSpec from '../public/openapi.json';
import { THEME_COOKIE } from './ui';
import { spaShell, type ThemeName } from './spa/shell';
import { serverHeaderHtml, serverFooterHtml, type ChromeUser } from './spa/chrome';
import { getUser, type SessionUser } from './auth/session';
import { isCrawler, servePrerendered } from './prerender';
import {
  acceptsMarkdown,
  agentLinkHeader,
  registerAgentRoutes,
  serveMarkdown,
} from './agent';
import { slugForId } from './db';

export interface Env {
  DB: D1Database;
  /** Workers AI binding (wrangler `[ai]`). May be absent in local dev. */
  AI: Ai;
  /** Admin allow-list for the news curation console (`wrangler secret put ADMIN_EMAILS`
      with a comma-separated list of owner emails). On every successful magic-link verify,
      matching users get users.is_admin = 1. Removing an email does NOT revoke (documented
      limitation); revoke manually via SQL. */
  ADMIN_EMAILS?: string;
  /** News-pipeline kill switch (`[vars] PIPELINE_ENABLED = "1"`). Anything else → scheduled run no-ops. */
  PIPELINE_ENABLED?: string;
  /** Cloudflare Email Service send binding (`[[send_email]] name = "EMAIL"` in wrangler.toml).
      Absent in local dev or until the owner onboards a sending domain → dev-link fallback / 503. */
  EMAIL?: SendEmail;
  /** 'development' shows magic links on-screen when email is unconfigured. Unset/anything else → fail closed. */
  ENVIRONMENT?: string;
  /** TMDB API key for future poster enrichment (`wrangler secret put TMDB_API_KEY`). Absent → stub no-ops. */
  TMDB_API_KEY?: string;
  /** IndexNow instant-indexing key (`wrangler secret put INDEXNOW_KEY` with a
   *  random hex string). Served at /{key}.txt and used to notify Bing/Yandex
   *  of new/changed catalog URLs. Absent → IndexNow disabled. */
  INDEXNOW_KEY?: string;
  /** TEMPORARY bearer token for the one-shot IndexNow bulk retry
   *  (`wrangler secret put BULK_RETRY_TOKEN`). Delete with the route. */
  BULK_RETRY_TOKEN?: string;
}

const app = new Hono<{ Bindings: Env }>();

const themeOf = (c: Context): ThemeName =>
  getCookie(c, THEME_COOKIE) === 'dark' ? 'dark' : 'light';

/** Serialize the session user for the shell's window.__naUser boot payload. */
const bootUserJson = (u: SessionUser | null) =>
  JSON.stringify(u ? { id: u.id, email: u.email, is_admin: u.isAdmin } : null).replace(
    /</g,
    '\\u003c',
  );

/**
 * Serve the SPA shell. The header/footer chrome is server-rendered into the
 * initial HTML (src/spa/chrome.ts, byte-identical to the client's renderer)
 * so first paint already has the page chrome — injecting it from JS after
 * boot was the site's largest layout-shift source. The client still calls
 * refreshChrome() on navigation; identical HTML means no shift.
 */
const serveShell = async (c: Context) => {
  const theme = themeOf(c);
  const sessionUser = await getUser(c);
  const user: ChromeUser | null = sessionUser
    ? { email: sessionUser.email, isAdmin: sessionUser.isAdmin }
    : null;
  const url = new URL(c.req.url);
  const pathname = url.pathname;
  const res = c.html(
    spaShell(
      theme,
      serverHeaderHtml(pathname, theme, user, url.search),
      serverFooterHtml(),
      bootUserJson(sessionUser),
      url.origin,
    ),
  );
  // Advertise the machine-readable resources (RFC 8288) on every page —
  // agents fetching the homepage discover the API catalog this way.
  res.headers.set('Link', agentLinkHeader(url.origin));
  return res;
};

// Bookmarkable SPA routes. GET /auth/verify?token=… serves the shell and the
// SPA consumes the token via POST /api/v1/auth/verify (magic-link emails keep
// working across the cutover).
//
// Bot-aware: requests with a crawler User-Agent get a lightweight prerendered
// HTML document (per-route title/meta/OG tags from D1, cached at the edge)
// instead of the SPA shell; real browsers always get the shell. Auth/admin
// routes and unknown IDs fall through to the shell (prerender returns null).
//
// Agent-first: before the bot/browser split, an explicit `Accept:
// text/markdown` request gets the Markdown rendering of the page (same content
// model as the bot HTML prerender, src/agent.ts). Non-renderable paths fall
// through to the normal dispatch below.
const servePage = async (c: Context) => {
  if (c.req.method === 'GET' && acceptsMarkdown(c.req.header('accept'))) {
    const md = await serveMarkdown(
      c.env.DB,
      c.req.url,
      (p) => c.executionCtx.waitUntil(p),
    );
    if (md) return md;
  }
  if (c.req.method === 'GET' && isCrawler(c.req.header('user-agent'))) {
    const prerendered = await servePrerendered(
      c.env.DB,
      c.req.url,
      (p) => c.executionCtx.waitUntil(p),
    );
    if (prerendered) return prerendered;
  }
  return serveShell(c);
};

// Numeric detail URLs are legacy: 301 them to the slug permalink before the
// crawler check so bots and browsers both learn the canonical URL.
const serveDetailPage = (table: 'books' | 'screen_works' | 'adaptations') => {
  return async (c: Context) => {
    const param = c.req.param('slug') ?? '';
    if (/^\d+$/.test(param)) {
      const slug = await slugForId(c.env.DB, table, Number(param));
      if (slug) {
        const url = new URL(c.req.url);
        const route = url.pathname.split('/')[1]; // watch | books | adaptations
        return c.redirect(`${url.origin}/${route}/${slug}${url.search}`, 301);
      }
    }
    return servePage(c);
  };
};

app.get('/', servePage);
app.get('/calendar', servePage);
app.get('/most-wanted', servePage);
app.get('/watch/:slug', serveDetailPage('screen_works'));
app.get('/adaptations/:slug', serveDetailPage('adaptations'));
app.get('/books/:slug', serveDetailPage('books'));
app.get('/search', servePage);
app.get('/lists', servePage);
app.get('/lists/:slug', servePage);
app.get('/shelves', servePage);
app.get('/feedback', servePage);
app.get('/privacy', servePage);
app.get('/terms', servePage);
app.get('/auth/login', servePage);
app.get('/auth/verify', servePage);
app.get('/admin/news', servePage);
app.get('/admin/news/runs', servePage);
app.get('/admin/screen-works', servePage);
app.get('/admin/feedback', servePage);

// Embedded favicon (src/favicon.ts — no [assets] static dir).
// Registered before the API so the icon paths are never shadowed.
app.get('/favicon.png', () => serveFavicon());
app.get('/favicon.ico', () => serveFavicon());
app.get('/apple-touch-icon.png', () => serveFavicon());

// Versioned JSON API. Registered after the page routes; a trailing wildcard
// inside src/api/v1.ts answers unknown /api/v1/* paths with the JSON error
// envelope.
mountV1(app);

// OpenAPI spec + interactive docs. Single source of truth is
// docs/openapi.yaml; public/openapi.json is generated alongside it via
// scripts/openapi-to-json.py. Served by the worker (dependency-free on our
// side: Redoc loads from CDN).
/** Interactive API docs shell (Redoc, CDN). */
function apiDocsShell(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Novel Adaptations — API docs</title>
<style>body { margin: 0; padding: 0; }</style>
</head>
<body>
<redoc spec-url="/api/openapi.json"></redoc>
<script src="https://cdn.jsdelivr.net/npm/redoc@2.5.1/bundles/redoc.standalone.js"></script>
</body>
</html>`;
}

app.get('/api/openapi.json', (c) => c.json(openapiSpec));
app.get('/api/docs', (c) => c.html(apiDocsShell()));

// SEO: /sitemap.xml + /robots.txt.
registerSeoRoutes(app);

// IndexNow key file (/{key}.txt) — after the static routes; non-matching
// paths fall through to the page routes below.
registerIndexNowKeyRoute(app);

// TEMPORARY one-shot IndexNow bulk retry (token-gated). Remove after the
// 2026-09-19 retry succeeds, along with src/indexnow_bulk_retry.ts.
registerIndexNowBulkRetryRoute(app);

// Agent readiness: Markdown negotiation (in servePage), RFC 9727 API catalog,
// and Agent Skills discovery.
registerAgentRoutes(app);

app.notFound(async (c) => {
  if (c.req.path.startsWith('/api/')) {
    return c.json({ error: { code: 'not_found', message: 'Not found.' } }, 404);
  }
  // Unknown page path → shell with a 404 status; the SPA router renders its
  // own not-found view without a reload.
  const theme = themeOf(c);
  const sessionUser = await getUser(c);
  const user: ChromeUser | null = sessionUser
    ? { email: sessionUser.email, isAdmin: sessionUser.isAdmin }
    : null;
  const url = new URL(c.req.url);
  const pathname = url.pathname;
  return c.html(
    spaShell(
      theme,
      serverHeaderHtml(pathname, theme, user, url.search),
      serverFooterHtml(),
      bootUserJson(sessionUser),
      url.origin,
    ),
    404,
  );
});

export default {
  // Hono's fetch is an arrow-function property, so it can be re-homed safely.
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    // Credits drain (migration 0026): every 2 minutes, one batch of cast +
    // ratings enrichment while work remains; no-ops otherwise. Self-draining,
    // so future titles that gain a tmdb_id get credits automatically.
    if (event.cron === '*/2 * * * *') {
      if (env.TMDB_API_KEY) {
        try {
          await runCreditsBatch({ DB: env.DB, TMDB_API_KEY: env.TMDB_API_KEY }, 40);
        } catch (e) {
          console.error('scheduled credits drain failed:', (e as Error).message);
        }
      }
      return;
    }
    // Wikipedia expansion drain (migration 0027): every 5 minutes, resolve +
    // create up to 40 candidates. Bootstraps itself: the first tick scrapes
    // the lists when the queue is empty (retried after 24h if a scrape ever
    // yields nothing).
    if (event.cron === '*/5 * * * *') {
      if (env.TMDB_API_KEY) {
        try {
          const total = await countTotalExpansion(env.DB);
          if (total === 0) {
            const since = await hoursSinceLastScrape(env.DB);
            if (since == null || since > 24) {
              const scrape = await scrapeAndStoreExpansionCandidates(env.DB);
              console.log(
                `expansion scrape: ${scrape.pages} pages, ${scrape.candidates} candidates (${scrape.dropped} dropped)`,
              );
            }
          }
          const batch = await processExpansionBatch(
            { DB: env.DB, TMDB_API_KEY: env.TMDB_API_KEY },
            40,
          );
          if (batch.processed > 0) {
            console.log(
              `expansion batch: ${batch.created} created, ${batch.skipped} skipped, ` +
                `${batch.failed} failed, ${batch.remaining} remaining`,
            );
          }
        } catch (e) {
          console.error('scheduled expansion drain failed:', (e as Error).message);
        }
      }
      return;
    }
    await scheduledNewsRun(env);
  },
};
