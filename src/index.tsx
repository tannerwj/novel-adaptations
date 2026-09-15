import { Hono } from 'hono';
import { AdaptationPage, BookPage, HomePage, Layout } from './ui';
import { getAdaptationSummary, getBook, getBookAdaptations, listAdaptations } from './db';

export interface Env {
  DB: D1Database;
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

app.notFound((c) => c.html(<Layout title="Not found">404 — page not found.</Layout>, 404));

export default app;
