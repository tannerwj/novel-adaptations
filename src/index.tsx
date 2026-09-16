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
import { registerSeoRoutes } from './seo';
// Versioned JSON API at /api/v1 — the SPA contract (docs/openapi.yaml).
import { mountV1 } from './api/v1';
import openapiSpec from '../public/openapi.json';
import { THEME_COOKIE } from './ui';
import { spaShell, type ThemeName } from './spa/shell';
import { serverHeaderHtml, serverFooterHtml, type ChromeUser } from './spa/chrome';
import { getUser } from './auth/session';

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
}

const app = new Hono<{ Bindings: Env }>();

const themeOf = (c: Context): ThemeName =>
  getCookie(c, THEME_COOKIE) === 'dark' ? 'dark' : 'light';

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
  const pathname = new URL(c.req.url).pathname;
  return c.html(
    spaShell(theme, serverHeaderHtml(pathname, theme, user), serverFooterHtml()),
  );
};

// Bookmarkable SPA routes. GET /auth/verify?token=… serves the shell and the
// SPA consumes the token via POST /api/v1/auth/verify (magic-link emails keep
// working across the cutover).
app.get('/', serveShell);
app.get('/calendar', serveShell);
app.get('/most-wanted', serveShell);
app.get('/watch/:id', serveShell);
app.get('/adaptations/:id', serveShell);
app.get('/books/:id', serveShell);
app.get('/search', serveShell);
app.get('/lists', serveShell);
app.get('/lists/:slug', serveShell);
app.get('/shelves', serveShell);
app.get('/feedback', serveShell);
app.get('/auth/login', serveShell);
app.get('/auth/verify', serveShell);
app.get('/admin/news', serveShell);
app.get('/admin/news/runs', serveShell);
app.get('/admin/screen-works', serveShell);
app.get('/admin/feedback', serveShell);

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
  const pathname = new URL(c.req.url).pathname;
  return c.html(
    spaShell(theme, serverHeaderHtml(pathname, theme, user), serverFooterHtml()),
    404,
  );
});

export default {
  // Hono's fetch is an arrow-function property, so it can be re-homed safely.
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    await scheduledNewsRun(env);
  },
};
