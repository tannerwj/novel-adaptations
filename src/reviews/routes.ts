// src/reviews/routes.ts — Track 2: spoiler-safe review API.
//
//   GET    /api/reviews?target_type=book&target_id=1  — public review list
//   POST   /api/reviews            — create a review (auth)
//   PUT    /api/reviews/:id        — edit own review (auth, author only)
//   DELETE /api/reviews/:id        — delete own review (auth, author only)
//
// One review per user per target: POST when one already exists answers 409
// and tells the caller to edit instead. UI pages are SSR'd separately in
// src/reviews/ui.tsx; this file is pure JSON (follows the votes API style).

import type { Context, Hono } from 'hono';
import { getBook, getScreenWork } from '../db';
import { requireUser, type SessionUser } from '../auth/session';
import {
  checkReviewsRate,
  createReview,
  deleteReview,
  getReview,
  getUserReview,
  listReviews,
  REVIEW_TARGET_TYPES,
  updateReview,
  type ReviewTargetType,
} from './db';

export const BODY_MAX = 5000;
export const TITLE_MAX = 120;

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

function isTargetType(v: unknown): v is ReviewTargetType {
  return typeof v === 'string' && (REVIEW_TARGET_TYPES as string[]).includes(v);
}

/** Non-empty after trimming, length within limits, title optional. */
function invalidReviewFields(body: unknown, title: unknown): string | null {
  if (typeof body !== 'string' || body.trim().length === 0) {
    return 'Review body cannot be empty.';
  }
  if (body.length > BODY_MAX) {
    return `Review body must be at most ${BODY_MAX} characters (yours is ${body.length}).`;
  }
  if (title !== undefined && title !== null && String(title).length > TITLE_MAX) {
    return `Title must be at most ${TITLE_MAX} characters.`;
  }
  return null;
}

function normalizeTitle(title: unknown): string | null {
  if (typeof title !== 'string') return null;
  const t = title.trim();
  return t.length > 0 ? t : null;
}

/** 404 when the target doesn't exist. */
async function targetExists(
  db: D1Database,
  targetType: ReviewTargetType,
  targetId: number,
): Promise<boolean> {
  if (targetType === 'book') {
    return (await getBook(db, targetId)) !== null;
  }
  return (await getScreenWork(db, targetId)) !== null;
}

function reviewJson(r: Awaited<ReturnType<typeof getReview>>): unknown {
  if (!r) return null;
  return {
    id: r.id,
    userId: r.userId,
    targetType: r.targetType,
    targetId: r.targetId,
    title: r.title,
    body: r.body,
    hasSpoilers: r.hasSpoilers,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    authorId: r.authorId,
    authorEmail: r.authorEmail,
  };
}

export function mountReviews<E extends { DB: D1Database }>(
  app: Hono<{ Bindings: E }>,
): void {
  // --- public list ----------------------------------------------------------

  app.get('/api/reviews', async (c) => {
    const targetType = c.req.query('target_type');
    const targetId = toInt(c.req.query('target_id'));
    if (!isTargetType(targetType)) {
      return c.json({ error: "target_type must be 'book' or 'screen_work'." }, 400);
    }
    if (targetId === null || targetId < 1) {
      return c.json({ error: 'target_id must be a positive integer.' }, 400);
    }
    const reviews = await listReviews(c.env.DB, targetType, targetId);
    return c.json({ reviews: reviews.map(reviewJson) });
  });

  // --- create ---------------------------------------------------------------

  app.post('/api/reviews', async (c) => {
    const user: SessionUser | null = await requireUser(c);
    if (!user) return c.json({ error: 'Sign in to write a review.' }, 401);

    const payload = await parseJsonBody(c);
    const targetType = payload['target_type'];
    const targetId = toInt(payload['target_id']);
    if (!isTargetType(targetType)) {
      return c.json({ error: "target_type must be 'book' or 'screen_work'." }, 400);
    }
    if (targetId === null || targetId < 1) {
      return c.json({ error: 'target_id must be a positive integer.' }, 400);
    }
    const fieldError = invalidReviewFields(payload['body'], payload['title']);
    if (fieldError) return c.json({ error: fieldError }, 400);
    if (!(await targetExists(c.env.DB, targetType, targetId))) {
      return c.json({ error: 'Target not found.' }, 404);
    }
    // One review per user per item — edit it instead.
    const existing = await getUserReview(c.env.DB, user.id, targetType, targetId);
    if (existing) {
      return c.json(
        { error: "You've already reviewed this — edit your existing review instead.", reviewId: existing.id },
        409,
      );
    }
    if (!(await checkReviewsRate(c.env.DB, user.id))) {
      return c.json({ error: 'Review limit reached — 20 reviews per hour.' }, 429);
    }
    const id = await createReview(
      c.env.DB,
      user.id,
      targetType,
      targetId,
      normalizeTitle(payload['title']),
      String(payload['body']).trim(),
      payload['has_spoilers'] === true,
    );
    return c.json({ review: reviewJson(await getReview(c.env.DB, id)) }, 201);
  });

  // --- edit own -------------------------------------------------------------

  app.put('/api/reviews/:id', async (c) => {
    const user: SessionUser | null = await requireUser(c);
    if (!user) return c.json({ error: 'Sign in to edit a review.' }, 401);

    const id = toInt(c.req.param('id'));
    if (id === null || id < 1) {
      return c.json({ error: 'Review id must be a positive integer.' }, 400);
    }
    const review = await getReview(c.env.DB, id);
    if (!review) return c.json({ error: 'Review not found.' }, 404);
    if (review.authorId !== user.id) {
      return c.json({ error: 'You can only edit your own reviews.' }, 403);
    }
    const payload = await parseJsonBody(c);
    const fieldError = invalidReviewFields(payload['body'], payload['title']);
    if (fieldError) return c.json({ error: fieldError }, 400);
    await updateReview(
      c.env.DB,
      user.id,
      id,
      normalizeTitle(payload['title']),
      String(payload['body']).trim(),
      payload['has_spoilers'] === true,
    );
    return c.json({ review: reviewJson(await getReview(c.env.DB, id)) });
  });

  // --- delete own -----------------------------------------------------------

  app.delete('/api/reviews/:id', async (c) => {
    const user: SessionUser | null = await requireUser(c);
    if (!user) return c.json({ error: 'Sign in to delete a review.' }, 401);

    const id = toInt(c.req.param('id'));
    if (id === null || id < 1) {
      return c.json({ error: 'Review id must be a positive integer.' }, 400);
    }
    const review = await getReview(c.env.DB, id);
    if (!review) return c.json({ error: 'Review not found.' }, 404);
    if (review.authorId !== user.id) {
      return c.json({ error: 'You can only delete your own reviews.' }, 403);
    }
    await deleteReview(c.env.DB, user.id, id);
    return c.json({ ok: true, id });
  });
}
