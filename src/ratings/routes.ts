// src/ratings/routes.ts — Track 1: public rating read, authenticated rating
// write (1–5 stars) on books and screen works.
//
//   GET    /api/ratings?target_type=book&target_id=1 — {average, count, userRating}
//   POST   /api/ratings {target_type, target_id, rating} — rate (auth)
//
// Ratings are SEPARATE from votes — this module never touches src/votes.

import type { Context, Hono } from 'hono';
import { getBook, getScreenWork } from '../db';
import { getUser, requireUser, type SessionUser } from '../auth/session';
import {
  checkRatingsRate,
  getRatingSummary,
  getUserRating,
  MAX_RATINGS_PER_HOUR,
  RATING_TARGET_TYPES,
  setRating,
  type RatingTargetType,
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
  return c.json({ error: 'Sign in to rate.' }, 401);
}

/** Verify the rated target exists (book or screen work). */
async function targetExists(
  db: D1Database,
  targetType: RatingTargetType,
  targetId: number,
): Promise<boolean> {
  if (targetType === 'book') {
    return (await getBook(db, targetId)) !== null;
  }
  return (await getScreenWork(db, targetId)) !== null;
}

export function mountRatings<E extends { DB: D1Database }>(
  app: Hono<{ Bindings: E }>,
): void {
  // --- public read: never 401; userRating is null when logged out -----------

  app.get('/api/ratings', async (c) => {
    const targetType = c.req.query('target_type') as RatingTargetType | undefined;
    const targetId = toInt(c.req.query('target_id'));
    if (!targetType || !RATING_TARGET_TYPES.includes(targetType)) {
      return c.json({ error: "target_type must be 'book' or 'screen_work'." }, 400);
    }
    if (targetId === null || targetId < 1) {
      return c.json({ error: 'target_id must be a positive integer.' }, 400);
    }

    const user = await getUser(c);
    const summary = await getRatingSummary(c.env.DB, targetType, targetId);
    const userRating =
      user === null ? null : await getUserRating(c.env.DB, user.id, targetType, targetId);
    return c.json({ average: summary.average, count: summary.count, userRating });
  });

  // --- write: auth required --------------------------------------------------

  app.post('/api/ratings', async (c) => {
    const user: SessionUser | null = await requireUser(c);
    if (!user) return unauthorized(c);

    const body = await parseJsonBody(c);
    const targetType = body['target_type'] as RatingTargetType | undefined;
    const targetId = toInt(body['target_id']);
    const rating = toInt(body['rating']);
    if (!targetType || !RATING_TARGET_TYPES.includes(targetType)) {
      return c.json({ error: "target_type must be 'book' or 'screen_work'." }, 400);
    }
    if (targetId === null || targetId < 1) {
      return c.json({ error: 'target_id must be a positive integer.' }, 400);
    }
    if (rating === null || rating < 1 || rating > 5) {
      return c.json({ error: 'rating must be an integer from 1 to 5.' }, 400);
    }
    if (!(await targetExists(c.env.DB, targetType, targetId))) {
      return c.json({ error: 'Target not found.' }, 404);
    }
    if (!(await checkRatingsRate(c.env.DB, user.id))) {
      return c.json(
        { error: `Rating limit reached — ${MAX_RATINGS_PER_HOUR} ratings per hour.` },
        429,
      );
    }

    await setRating(c.env.DB, user.id, targetType, targetId, rating);
    const summary = await getRatingSummary(c.env.DB, targetType, targetId);
    return c.json({ average: summary.average, count: summary.count, userRating: rating });
  });
}
