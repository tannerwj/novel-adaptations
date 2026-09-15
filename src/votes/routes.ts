// src/votes/routes.ts — Most Wanted leaderboard, vote API, and shelves.
//
//   GET    /most-wanted        — leaderboard page (MostWantedPage)
//   GET    /api/most-wanted    — leaderboard JSON
//   POST   /api/votes          — cast a vote {bookId} (auth)
//   DELETE /api/votes/:bookId  — withdraw a vote (auth)
//   GET    /shelves            — my shelves page (auth; ShelvesPage)
//   POST   /api/shelves        — add/move shelf entry (auth)
//   DELETE /api/shelves        — remove shelf entry (auth)
//
// NOTE: page components are called as plain functions (no JSX) so this file
// stays .ts. `MostWantedPage({...})` is exactly what JSX desugars to.

import type { Context, Hono } from 'hono';
import { getAdaptationSummary, getBook } from '../db';
import { MostWantedPage, ShelvesPage, themeOf } from '../ui';
import { getUser, requireUser, type SessionUser } from '../auth/session';
import {
  castVote,
  checkVoteRate,
  getMostWanted,
  hasVoted,
  listShelves,
  removeShelf,
  SHELF_TARGET_TYPES,
  SHELVES,
  upsertShelf,
  withdrawVote,
  type ShelfName,
  type ShelfTargetType,
} from './db';

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
  return c.json({ error: 'Sign in to vote.' }, 401);
}

export function mountVotes<E extends { DB: D1Database }>(
  app: Hono<{ Bindings: E }>,
): void {
  // --- Most Wanted ---------------------------------------------------------

  app.get('/most-wanted', async (c) => {
    const user = await getUser(c);
    const rows = await getMostWanted(c.env.DB, user?.id ?? null);
    return c.html(
      MostWantedPage({
        items: rows.map((r) => ({
          book: {
            id: r.bookId,
            title: r.title,
            authors: r.authors,
            coverUrl: r.coverUrl,
          },
          votes: r.votes,
          userVoted: r.userVoted,
        })),
        user: user ? { email: user.email, isAdmin: user.isAdmin } : null,
        origin: new URL(c.req.url).origin,
        theme: themeOf(c),
      }),
    );
  });

  app.get('/api/most-wanted', async (c) => {
    const user = await getUser(c);
    const rows = await getMostWanted(c.env.DB, user?.id ?? null);
    return c.json({
      items: rows.map((r) => ({
        bookId: r.bookId,
        title: r.title,
        authors: r.authors,
        coverUrl: r.coverUrl,
        votes: r.votes,
        userVoted: r.userVoted,
      })),
    });
  });

  // --- votes ---------------------------------------------------------------

  app.post('/api/votes', async (c) => {
    const user: SessionUser | null = await requireUser(c);
    if (!user) return unauthorized(c);

    const body = await parseJsonBody(c);
    const bookId = toInt(body['bookId']);
    if (bookId === null || bookId < 1) {
      return c.json({ error: 'bookId must be a positive integer.' }, 400);
    }
    const book = await getBook(c.env.DB, bookId);
    if (!book) {
      return c.json({ error: 'Book not found.' }, 404);
    }
    // Idempotent re-vote doesn't consume the daily rate budget.
    if (!(await hasVoted(c.env.DB, user.id, bookId))) {
      if (!(await checkVoteRate(c.env.DB, user.id))) {
        return c.json({ error: 'Vote limit reached — 20 votes per day.' }, 429);
      }
    }
    const result = await castVote(c.env.DB, user.id, bookId);
    return c.json(result);
  });

  app.delete('/api/votes/:bookId', async (c) => {
    const user: SessionUser | null = await requireUser(c);
    if (!user) return unauthorized(c);

    const bookId = toInt(c.req.param('bookId'));
    if (bookId === null || bookId < 1) {
      return c.json({ error: 'bookId must be a positive integer.' }, 400);
    }
    const result = await withdrawVote(c.env.DB, user.id, bookId);
    return c.json(result);
  });

  // --- shelves ---------------------------------------------------------------

  app.get('/shelves', async (c) => {
    const user: SessionUser | null = await requireUser(c);
    if (!user) return c.redirect('/auth/login', 303);

    const shelves = await listShelves(c.env.DB, user.id);
    return c.html(
      ShelvesPage({
        shelves: shelves.map((s) => ({
          targetType: s.targetType,
          targetId: s.targetId,
          title: s.title,
          shelf: s.shelf,
        })),
        user: { email: user.email, isAdmin: user.isAdmin },
        theme: themeOf(c),
      }),
    );
  });

  app.post('/api/shelves', async (c) => {
    const user: SessionUser | null = await requireUser(c);
    if (!user) return unauthorized(c);

    const body = await parseJsonBody(c);
    const targetType = body['targetType'] as ShelfTargetType | undefined;
    const targetId = toInt(body['targetId']);
    const shelf = body['shelf'] as ShelfName | undefined;
    if (!targetType || !SHELF_TARGET_TYPES.includes(targetType)) {
      return c.json({ error: "targetType must be 'book' or 'adaptation'." }, 400);
    }
    if (!shelf || !SHELVES.includes(shelf)) {
      return c.json({ error: "shelf must be 'want_to_read', 'read', 'want_to_watch', or 'watched'." }, 400);
    }
    if (targetId === null || targetId < 1) {
      return c.json({ error: 'targetId must be a positive integer.' }, 400);
    }
    const exists =
      targetType === 'book'
        ? (await getBook(c.env.DB, targetId)) !== null
        : (await getAdaptationSummary(c.env.DB, targetId)) !== null;
    if (!exists) {
      return c.json({ error: 'Target not found.' }, 404);
    }

    await upsertShelf(c.env.DB, user.id, targetType, targetId, shelf);
    return c.json({ ok: true });
  });

  app.delete('/api/shelves', async (c) => {
    const user: SessionUser | null = await requireUser(c);
    if (!user) return unauthorized(c);

    const body = await parseJsonBody(c);
    const targetType = body['targetType'] as ShelfTargetType | undefined;
    const targetId = toInt(body['targetId']);
    if (!targetType || !SHELF_TARGET_TYPES.includes(targetType)) {
      return c.json({ error: "targetType must be 'book' or 'adaptation'." }, 400);
    }
    if (targetId === null || targetId < 1) {
      return c.json({ error: 'targetId must be a positive integer.' }, 400);
    }
    await removeShelf(c.env.DB, user.id, targetType, targetId);
    return c.json({ ok: true });
  });
}
