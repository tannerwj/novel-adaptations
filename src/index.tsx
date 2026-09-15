import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { AdaptationPage, BookPage, HomePage, Layout, THEME_COOKIE, themeOf } from './ui';
import { ScreenWorkPage } from './watch';
import {
  getAdaptationSummary,
  getBook,
  getBookAdaptations,
  getScreenWork,
  getScreenWorkNews,
  listAdaptations,
} from './db';
import { registerCurationRoutes } from './news/curation';
import { scheduledNewsRun } from './news/ingest';
import { getUser, type SessionUser } from './auth/session';
import { mountAuth } from './auth/routes';
import { mountVotes } from './votes/routes';
import { mountFeedback } from './feedback/routes';
import { getAdaptationTimeline, getBookVoteState } from './votes/detail';
import { getShelf } from './votes/db';
import { serveFavicon } from './favicon';
// Round 3: release calendar, site search, SEO, in-worker TMDB enrichment.
import { registerCalendarRoutes } from './calendar';
import { getWatchProviders } from './watch_providers';
import { registerSearchRoutes } from './search';
import { registerSeoRoutes } from './seo';
import { registerEnrichmentRoutes } from './enrichment';
// Round 4: community — ratings, spoiler-safe reviews, polls, hype, lists.
import { mountRatings } from './ratings/routes';
import { mountReviews } from './reviews/routes';
import { mountPolls } from './polls/routes';
import { mountHype } from './hype/routes';
import { mountLists } from './lists/routes';
import { getRatingSummary, getUserRating } from './ratings/db';
import { listReviews } from './reviews/db';
import { getPollResults, getUserChoice } from './polls/db';
import { getHypeSummary, getUserHype, isUnreleased } from './hype/db';
import { listUserLists } from './lists/db';

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

/** Project a SessionUser into the shape pages/header consume. */
const toAuthUser = (user: SessionUser | null) =>
  user ? { email: user.email, isAdmin: user.isAdmin } : null;

app.get('/', async (c) => {
  const adaptations = await listAdaptations(c.env.DB);
  const user = await getUser(c);
  return c.html(
    <HomePage
      adaptations={adaptations}
      user={toAuthUser(user)}
      origin={new URL(c.req.url).origin}
      theme={themeOf(c)}
    />,
  );
});

// Track A: theme toggle (no-JS friendly). Accepts form fields `theme` and
// `next`; sets the 1-year `theme` cookie, then 303s back to `next`.
// `next` is validated as a local path to avoid open redirects.
app.post('/api/theme', async (c) => {
  let rawTheme: string | null = null;
  let rawNext: string | null = null;
  try {
    const body = await c.req.parseBody();
    const t = body['theme'];
    const n = body['next'];
    rawTheme = typeof t === 'string' ? t : null;
    rawNext = typeof n === 'string' ? n : null;
  } catch {
    // fall through with defaults
  }
  const theme = rawTheme === 'dark' || rawTheme === 'light' ? rawTheme : 'light';
  // Where to send the no-JS fallback after the toggle: prefer the Referer
  // (same-origin only) so the toggle returns to the page it was used on,
  // then the explicit `next` form field, then '/'.
  const isLocalPath = (p: string) => /^\/[^/\\]/.test(p) && !p.includes('://');
  let next = '/';
  const selfUrl = new URL(c.req.url);
  const ref = c.req.header('referer');
  if (ref) {
    try {
      const u = new URL(ref, selfUrl);
      if (u.origin === selfUrl.origin && isLocalPath(u.pathname)) {
        next = u.pathname + u.search;
      }
    } catch {
      // malformed Referer — fall through to `next` field / '/'
    }
  }
  if (next === '/' && rawNext && isLocalPath(rawNext)) next = rawNext;
  // Share the theme cookie between apex and www so the toggle sticks on
  // both hosts. Never set Domain on other hosts (e.g. workers.dev previews).
  const host = new URL(c.req.url).hostname;
  const sharedDomain =
    host === 'noveladaptations.com' || host === 'www.noveladaptations.com'
      ? 'noveladaptations.com'
      : undefined;
  setCookie(c, THEME_COOKIE, theme, {
    path: '/',
    maxAge: 31536000,
    sameSite: 'Lax',
    ...(sharedDomain ? { domain: sharedDomain } : {}),
  });
  return c.redirect(next, 303);
});

app.get('/adaptations/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) {
    return c.html(<Layout title="Not found" theme={themeOf(c)}>404 — adaptation not found.</Layout>, 404);
  }
  const adaptation = await getAdaptationSummary(c.env.DB, id);
  if (!adaptation) {
    return c.html(<Layout title="Not found" theme={themeOf(c)}>404 — adaptation not found.</Layout>, 404);
  }
  const user = await getUser(c);
  const timeline = await getAdaptationTimeline(c.env.DB, id);
  const userVoted = user ? await getBookVoteState(c.env.DB, user.id, adaptation.book_id) : false;
  const userShelf = user ? await getShelf(c.env.DB, user.id, 'adaptation', id) : null;
  const pollResults = await getPollResults(c.env.DB, id);
  const pollChoice = user ? await getUserChoice(c.env.DB, user.id, id) : null;
  return c.html(
    <AdaptationPage
      adaptation={adaptation}
      timeline={timeline}
      userVoted={userVoted}
      userShelf={userShelf}
      pollResults={pollResults}
      pollChoice={pollChoice}
      user={toAuthUser(user)}
      origin={new URL(c.req.url).origin}
      canonicalPath={c.req.path}
      theme={themeOf(c)}
    />,
  );
});

app.get('/books/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) {
    return c.html(<Layout title="Not found" theme={themeOf(c)}>404 — book not found.</Layout>, 404);
  }
  const book = await getBook(c.env.DB, id);
  if (!book) {
    return c.html(<Layout title="Not found" theme={themeOf(c)}>404 — book not found.</Layout>, 404);
  }
  const adaptations = await getBookAdaptations(c.env.DB, id);
  const user = await getUser(c);
  const userVoted = user ? await getBookVoteState(c.env.DB, user.id, id) : false;
  const userShelf = user ? await getShelf(c.env.DB, user.id, 'book', id) : null;
  const ratingSummary = await getRatingSummary(c.env.DB, 'book', id);
  const userRating = user ? await getUserRating(c.env.DB, user.id, 'book', id) : null;
  const reviews = await listReviews(c.env.DB, 'book', id);
  const userLists = user
    ? (await listUserLists(c.env.DB, user.id)).map((l) => ({ id: l.id, title: l.title }))
    : [];
  return c.html(
    <BookPage
      book={book}
      adaptations={adaptations}
      userVoted={userVoted}
      userShelf={userShelf}
      ratingSummary={ratingSummary}
      userRating={userRating}
      reviews={reviews}
      userId={user?.id ?? null}
      userLists={userLists}
      user={toAuthUser(user)}
      origin={new URL(c.req.url).origin}
      canonicalPath={c.req.path}
      theme={themeOf(c)}
    />,
  );
});

app.get('/api/adaptations', async (c) => {
  const adaptations = await listAdaptations(c.env.DB);
  return c.json(adaptations);
});

// Embedded favicon (src/favicon.ts — no [assets] static dir).
// Registered before auth/vote mounts so the icon paths are never shadowed.
app.get('/favicon.png', () => serveFavicon());
app.get('/favicon.ico', () => serveFavicon());
app.get('/apple-touch-icon.png', () => serveFavicon());

// /watch/:id = the screen work itself (film/series), NOT the adaptation story.
// /adaptations/:id remains "the adaptation story" (book→screen journey + timeline).
app.get('/watch/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) {
    return c.html(<Layout title="Not found" theme={themeOf(c)}>404 — screen work not found.</Layout>, 404);
  }
  const work = await getScreenWork(c.env.DB, id);
  if (!work) {
    return c.html(<Layout title="Not found" theme={themeOf(c)}>404 — screen work not found.</Layout>, 404);
  }
  const news = await getScreenWorkNews(
    c.env.DB,
    work.books.map((b) => b.title),
  );
  // Round 3: where-to-watch providers (7-day D1 cache; never throws, never
  // blocks render beyond a cold-miss fetch) + SEO origin for canonical/OG tags.
  const providers = await getWatchProviders(c.env.DB, c.executionCtx, c.env, {
    id: work.id,
    tmdb_id: work.tmdb_id,
    kind: work.kind,
  });
  const user = await getUser(c);
  const origin = new URL(c.req.url).origin;
  // Round 4: community widgets — ratings, reviews, hype (unreleased only), lists.
  const ratingSummary = await getRatingSummary(c.env.DB, 'screen_work', id);
  const userRating = user ? await getUserRating(c.env.DB, user.id, 'screen_work', id) : null;
  const reviews = await listReviews(c.env.DB, 'screen_work', id);
  const showHype = isUnreleased(work.release_date);
  const hypeSummary = showHype ? await getHypeSummary(c.env.DB, id) : null;
  const userHype = showHype && user ? await getUserHype(c.env.DB, user.id, id) : null;
  const userLists = user
    ? (await listUserLists(c.env.DB, user.id)).map((l) => ({ id: l.id, title: l.title }))
    : [];
  return c.html(
    <ScreenWorkPage
      work={work}
      news={news}
      providers={providers}
      origin={origin}
      canonicalPath={c.req.path}
      user={toAuthUser(user)}
      theme={themeOf(c)}
      ratingSummary={ratingSummary}
      userRating={userRating}
      reviews={reviews}
      userId={user?.id ?? null}
      hype={hypeSummary ? { ...hypeSummary, userLevel: userHype } : null}
      userLists={userLists}
    />,
  );
});

// Phase 2: magic-link auth + voting/shelves.
mountAuth(app);
mountVotes(app);

// Round 4: community — ratings, spoiler-safe reviews, book-vs-screen polls,
// hype meter, shareable lists.
mountRatings(app);
mountReviews(app);
mountPolls(app);
mountHype(app);
mountLists(app);

// Public feedback + admin triage queue.
mountFeedback(app);

// Owner-only news curation queue + API (gated by admin sessions; see
// src/auth/session.ts requireAdminPage / requireAdminApi).
registerCurationRoutes(app);

// Round 3: release calendar, site search, SEO (sitemap/robots), and
// in-worker TMDB enrichment (self-gated admin endpoint).
registerCalendarRoutes(app);
registerSearchRoutes(app);
registerSeoRoutes(app);
registerEnrichmentRoutes(app);

app.notFound((c) => c.html(<Layout title="Not found" theme={themeOf(c)}>404 — page not found.</Layout>, 404));

export default {
  // Hono's fetch is an arrow-function property, so it can be re-homed safely.
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    await scheduledNewsRun(env);
  },
};
