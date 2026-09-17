// RETIRED — unmounted SSR-era route module, archived 2026-09-17 (finding 23).
// Nothing imports this file; the SPA is served by src/api/v1.ts + public/js/.
// Kept for reference only — do not add new code here.
// Original location: src/lists/routes.ts

// src/lists/routes.ts — shareable user lists (Track 5).
//
//   GET    /lists                — "My lists" page (auth)
//   GET    /lists/:slug          — public list detail page
//   POST   /api/lists            — create a list {title, description?, is_public?}
//   PUT    /api/lists/:id        — rename/edit a list (owner)
//   DELETE /api/lists/:id        — delete a list (owner)
//   POST   /api/lists/:id/items  — add an item {target_type, target_id, note?} (owner)
//   DELETE /api/lists/:id/items/:itemId — remove an item (owner)
//   PUT    /api/lists/:id/items  — reorder {order: [itemIds]} (owner)
//
// Private lists 404 for non-owners (existence is never leaked). Page
// components are called as plain functions (no JSX) — `ListsPage({...})`
// is exactly what JSX desugars to.

import type { Context, Hono } from 'hono';
import { ListDetailPage, ListsPage } from '../lists/ui';
import { themeOf } from '../ui';
import { getUser, requireUser, type SessionUser } from '../auth/session';
import {
  addItem,
  checkListRate,
  createList,
  deleteList,
  getListById,
  getListBySlug,
  listListItems,
  listUserLists,
  LIST_TARGET_TYPES,
  removeItem,
  reorderItems,
  updateList,
  type ListTargetType,
} from '../lists/db';

const MAX_TITLE = 120;
const MAX_DESCRIPTION = 2000;
const MAX_NOTE = 500;

async function parseJsonBody(c: Context): Promise<Record<string, unknown>> {
  try {
    const b = await c.req.json();
    return typeof b === 'object' && b !== null ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toInt(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isInteger(n) ? (n as number) : null;
}

function unauthorized(c: Context) {
  return c.json({ error: 'Sign in to manage lists.' }, 401);
}

function cleanStr(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length > 0 && s.length <= max ? s : null;
}

export function mountLists<E extends { DB: D1Database }>(
  app: Hono<{ Bindings: E }>,
): void {
  // --- My lists ------------------------------------------------------------

  app.get('/lists', async (c) => {
    const user: SessionUser | null = await requireUser(c);
    if (!user) return c.redirect('/auth/login', 303);

    const lists = await listUserLists(c.env.DB, user.id);
    return c.html(
      ListsPage({
        lists: lists.map((l) => ({
          id: l.id,
          title: l.title,
          description: l.description,
          isPublic: l.is_public === 1,
          slug: l.slug,
          itemCount: l.itemCount,
          createdAt: l.created_at,
        })),
        user: { email: user.email, isAdmin: user.isAdmin },
        theme: themeOf(c),
      }),
    );
  });

  // --- Public list detail --------------------------------------------------

  app.get('/lists/:slug', async (c) => {
    const slug = c.req.param('slug');
    const list = await getListBySlug(c.env.DB, slug);
    const user = await getUser(c);
    const isOwner = !!user && !!list && list.user_id === user.id;
    // Private lists 404 for non-owners — never leak that a list exists.
    if (!list || (list.is_public !== 1 && !isOwner)) {
      return c.text('List not found.', 404);
    }

    const items = await listListItems(c.env.DB, list.id);
    const origin = new URL(c.req.url).origin;
    const description =
      list.description?.trim() ||
      `A ${list.is_public === 1 ? 'public' : 'private'} list of ${items.length} ${
        items.length === 1 ? 'title' : 'titles'
      } on Novel Adaptations.`;
    const ogImage = items.find((i) => i.imageUrl?.trim())?.imageUrl?.trim() ?? undefined;
    return c.html(
      ListDetailPage({
        list: {
          id: list.id,
          title: list.title,
          description: list.description,
          isPublic: list.is_public === 1,
          slug: list.slug,
          createdAt: list.created_at,
        },
        items: items.map((i) => ({
          id: i.id,
          targetType: i.targetType,
          targetId: i.targetId,
          note: i.note,
          title: i.title,
          subtitle: i.subtitle,
          imageUrl: i.imageUrl,
          href: i.href,
        })),
        isOwner,
        user: user ? { email: user.email, isAdmin: user.isAdmin } : null,
        origin,
        canonicalPath: `/lists/${list.slug}`,
        ogDescription: description,
        ogImage,
        theme: themeOf(c),
      }),
    );
  });

  // --- list CRUD -----------------------------------------------------------

  app.post('/api/lists', async (c) => {
    const user: SessionUser | null = await requireUser(c);
    if (!user) return unauthorized(c);

    const body = await parseJsonBody(c);
    const title = cleanStr(body['title'], MAX_TITLE);
    if (!title) {
      return c.json({ error: `title must be a non-empty string of at most ${MAX_TITLE} characters.` }, 400);
    }
    let description: string | null = null;
    if (body['description'] !== undefined && body['description'] !== null) {
      description = cleanStr(body['description'], MAX_DESCRIPTION);
      if (description === null && String(body['description']).trim() !== '') {
        return c.json({ error: `description must be at most ${MAX_DESCRIPTION} characters.` }, 400);
      }
    }
    const isPublic = body['is_public'] === undefined ? true : body['is_public'] !== false;

    if (!(await checkListRate(c.env.DB, user.id))) {
      return c.json({ error: `List limit reached — ${20} lists per hour.` }, 429);
    }
    const { id, slug } = await createList(c.env.DB, user.id, {
      title,
      description,
      isPublic,
    });
    return c.json({ id, slug }, 201);
  });

  app.put('/api/lists/:id', async (c) => {
    const user: SessionUser | null = await requireUser(c);
    if (!user) return unauthorized(c);

    const id = toInt(c.req.param('id'));
    if (id === null || id < 1) return c.json({ error: 'Invalid list id.' }, 400);
    const body = await parseJsonBody(c);

    const input: { title?: string; description?: string | null; isPublic?: boolean } = {};
    if (body['title'] !== undefined) {
      const title = cleanStr(body['title'], MAX_TITLE);
      if (!title) {
        return c.json({ error: `title must be a non-empty string of at most ${MAX_TITLE} characters.` }, 400);
      }
      input.title = title;
    }
    if (body['description'] !== undefined) {
      if (body['description'] === null || String(body['description']).trim() === '') {
        input.description = null;
      } else {
        const d = cleanStr(body['description'], MAX_DESCRIPTION);
        if (!d) {
          return c.json({ error: `description must be at most ${MAX_DESCRIPTION} characters.` }, 400);
        }
        input.description = d;
      }
    }
    if (body['is_public'] !== undefined) input.isPublic = body['is_public'] !== false;

    const result = await updateList(c.env.DB, user.id, id, input);
    if (result === 'not_found') return c.json({ error: 'List not found.' }, 404);
    if (result === 'forbidden') return c.json({ error: 'You do not own this list.' }, 403);
    return c.json({ ok: true });
  });

  app.delete('/api/lists/:id', async (c) => {
    const user: SessionUser | null = await requireUser(c);
    if (!user) return unauthorized(c);

    const id = toInt(c.req.param('id'));
    if (id === null || id < 1) return c.json({ error: 'Invalid list id.' }, 400);
    const result = await deleteList(c.env.DB, user.id, id);
    if (result === 'not_found') return c.json({ error: 'List not found.' }, 404);
    if (result === 'forbidden') return c.json({ error: 'You do not own this list.' }, 403);
    return c.json({ ok: true });
  });

  // --- list items ----------------------------------------------------------

  app.post('/api/lists/:id/items', async (c) => {
    const user: SessionUser | null = await requireUser(c);
    if (!user) return unauthorized(c);

    const id = toInt(c.req.param('id'));
    if (id === null || id < 1) return c.json({ error: 'Invalid list id.' }, 400);
    const body = await parseJsonBody(c);

    const targetType = body['target_type'] as ListTargetType | undefined;
    const targetId = toInt(body['target_id']);
    if (!targetType || !LIST_TARGET_TYPES.includes(targetType)) {
      return c.json({ error: "target_type must be 'book' or 'screen_work'." }, 400);
    }
    if (targetId === null || targetId < 1) {
      return c.json({ error: 'target_id must be a positive integer.' }, 400);
    }
    let note: string | null = null;
    if (body['note'] !== undefined && body['note'] !== null) {
      if (typeof body['note'] !== 'string') {
        return c.json({ error: 'note must be a string.' }, 400);
      }
      const trimmed = body['note'].trim();
      if (trimmed.length > MAX_NOTE) {
        return c.json({ error: `note must be at most ${MAX_NOTE} characters.` }, 400);
      }
      note = trimmed || null;
    }

    const result = await addItem(c.env.DB, user.id, id, { targetType, targetId, note });
    if (result.status !== 'ok') {
      const errorMap = {
        not_found: [404, 'List not found.'],
        forbidden: [403, 'You do not own this list.'],
        target_not_found: [404, 'Book or screen work not found.'],
        duplicate: [409, 'This item is already on the list.'],
      } as const;
      const [status, error] = errorMap[result.status];
      return c.json({ error }, status);
    }
    return c.json({ id: result.id }, 201);
  });

  app.delete('/api/lists/:id/items/:itemId', async (c) => {
    const user: SessionUser | null = await requireUser(c);
    if (!user) return unauthorized(c);

    const id = toInt(c.req.param('id'));
    const itemId = toInt(c.req.param('itemId'));
    if (id === null || id < 1) return c.json({ error: 'Invalid list id.' }, 400);
    if (itemId === null || itemId < 1) return c.json({ error: 'Invalid item id.' }, 400);

    const result = await removeItem(c.env.DB, user.id, id, itemId);
    if (result === 'not_found') return c.json({ error: 'List not found.' }, 404);
    if (result === 'forbidden') return c.json({ error: 'You do not own this list.' }, 403);
    if (result === 'item_not_found') return c.json({ error: 'Item not found on this list.' }, 404);
    return c.json({ ok: true });
  });

  app.put('/api/lists/:id/items', async (c) => {
    const user: SessionUser | null = await requireUser(c);
    if (!user) return unauthorized(c);

    const id = toInt(c.req.param('id'));
    if (id === null || id < 1) return c.json({ error: 'Invalid list id.' }, 400);
    const body = await parseJsonBody(c);
    const order = body['order'];
    if (
      !Array.isArray(order) ||
      order.some((v) => !Number.isInteger(v) || (v as number) < 1)
    ) {
      return c.json({ error: 'order must be an array of positive integer item ids.' }, 400);
    }

    // Ownership check first (404/403 take precedence over a bad order body).
    const list = await getListById(c.env.DB, id);
    if (!list) return c.json({ error: 'List not found.' }, 404);
    if (list.user_id !== user.id) return c.json({ error: 'You do not own this list.' }, 403);

    const result = await reorderItems(c.env.DB, user.id, id, order as number[]);
    if (result === 'bad_ids') {
      return c.json({ error: 'order contains unknown or duplicate item ids.' }, 400);
    }
    return c.json({ ok: true });
  });
}
