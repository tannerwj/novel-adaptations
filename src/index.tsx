import { Hono } from 'hono';
import { AdaptationPage, BookPage, HomePage, Layout } from './ui';
import { getAdaptationSummary, getBook, getBookAdaptations, listAdaptations } from './db';
import { registerCurationRoutes } from './news/curation';
import { scheduledNewsRun } from './news/ingest';

export interface Env {
  DB: D1Database;
  /** Workers AI binding (wrangler `[ai]`). May be absent in local dev. */
  AI: Ai;
  /** Owner curation secret (`wrangler secret put CURATION_KEY`). Absent → curation routes deny all. */
  CURATION_KEY: string;
}

const app = new Hono<{ Bindings: Env }>();

app.get('/', async (c) => {
  const adaptations = await listAdaptations(c.env.DB);
  return c.html(<HomePage adaptations={adaptations} />);
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
  return c.html(<AdaptationPage adaptation={adaptation} />);
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
  return c.html(<BookPage book={book} adaptations={adaptations} />);
});

app.get('/api/adaptations', async (c) => {
  const adaptations = await listAdaptations(c.env.DB);
  return c.json(adaptations);
});

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
