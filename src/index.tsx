import { Hono } from 'hono';
import { AdaptationPage, BookPage, HomePage, Layout } from './ui';
import { getAdaptationSummary, getBook, getBookAdaptations, listAdaptations } from './db';
import { registerCurationRoutes } from './news/curation';
import { scheduledNewsRun } from './news/ingest';
import { getUser } from './auth/session';
import { mountAuth } from './auth/routes';
import { mountVotes } from './votes/routes';
import { getAdaptationTimeline, getBookVoteState } from './votes/detail';
import { getShelf } from './votes/db';

export interface Env {
  DB: D1Database;
  /** Workers AI binding (wrangler `[ai]`). May be absent in local dev. */
  AI: Ai;
  /** Owner curation secret (`wrangler secret put CURATION_KEY`). Absent → curation routes deny all. */
  CURATION_KEY: string;
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

app.get('/', async (c) => {
  const adaptations = await listAdaptations(c.env.DB);
  const user = await getUser(c);
  return c.html(
    <HomePage adaptations={adaptations} user={user ? { email: user.email } : null} />,
  );
});

app.get('/adaptations/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) {
    return c.html(<Layout title="Not found">404 — adaptation not found.</Layout>, 404);
  }
  const adaptation = await getAdaptationSummary(c.env.DB, id);
  if (!adaptation) {
    return c.html(<Layout title="Not found">404 — adaptation not found.</Layout>, 404);
  }
  const user = await getUser(c);
  const timeline = await getAdaptationTimeline(c.env.DB, id);
  const userVoted = user ? await getBookVoteState(c.env.DB, user.id, adaptation.book_id) : false;
  const userShelf = user ? await getShelf(c.env.DB, user.id, 'adaptation', id) : null;
  return c.html(
    <AdaptationPage
      adaptation={adaptation}
      timeline={timeline}
      userVoted={userVoted}
      userShelf={userShelf}
      user={user ? { email: user.email } : null}
    />,
  );
});

app.get('/books/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) {
    return c.html(<Layout title="Not found">404 — book not found.</Layout>, 404);
  }
  const book = await getBook(c.env.DB, id);
  if (!book) {
    return c.html(<Layout title="Not found">404 — book not found.</Layout>, 404);
  }
  const adaptations = await getBookAdaptations(c.env.DB, id);
  const user = await getUser(c);
  const userVoted = user ? await getBookVoteState(c.env.DB, user.id, id) : false;
  const userShelf = user ? await getShelf(c.env.DB, user.id, 'book', id) : null;
  return c.html(
    <BookPage
      book={book}
      adaptations={adaptations}
      userVoted={userVoted}
      userShelf={userShelf}
      user={user ? { email: user.email } : null}
    />,
  );
});

app.get('/api/adaptations', async (c) => {
  const adaptations = await listAdaptations(c.env.DB);
  return c.json(adaptations);
});

// Phase 2: magic-link auth + voting/shelves.
mountAuth(app);
mountVotes(app);

// Owner-only news curation queue + API (gated by CURATION_KEY in curation.ts).
registerCurationRoutes(app);

app.notFound((c) => c.html(<Layout title="Not found">404 — page not found.</Layout>, 404));

export default {
  // Hono's fetch is an arrow-function property, so it can be re-homed safely.
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    await scheduledNewsRun(env);
  },
};
