// src/polls/routes.ts — Track 3: book-vs-screen poll API.
//
//   GET  /api/polls/:adaptationId  — public results + the caller's choice
//   POST /api/polls/:adaptationId  — cast/change a vote {choice} (auth)
//
// The GET never 401s: logged-out callers just get userChoice: null.

import type { Context, Hono } from 'hono';
import { getAdaptationSummary } from '../db';
import { getUser, requireUser, type SessionUser } from '../auth/session';
import {
  checkPollsRate,
  getPollResults,
  getUserChoice,
  POLL_CHOICES,
  setPollVote,
  type PollChoice,
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

export function mountPolls<E extends { DB: D1Database }>(
  app: Hono<{ Bindings: E }>,
): void {
  // --- public results ------------------------------------------------------

  app.get('/api/polls/:adaptationId', async (c) => {
    const adaptationId = toInt(c.req.param('adaptationId'));
    if (adaptationId === null || adaptationId < 1) {
      return c.json({ error: 'adaptationId must be a positive integer.' }, 400);
    }
    const adaptation = await getAdaptationSummary(c.env.DB, adaptationId);
    if (!adaptation) {
      return c.json({ error: 'Adaptation not found.' }, 404);
    }
    const user: SessionUser | null = await getUser(c);
    const results = await getPollResults(c.env.DB, adaptationId);
    const userChoice = user
      ? await getUserChoice(c.env.DB, user.id, adaptationId)
      : null;
    return c.json({ ...results, userChoice });
  });

  // --- cast / change a vote ------------------------------------------------

  app.post('/api/polls/:adaptationId', async (c) => {
    const user: SessionUser | null = await requireUser(c);
    if (!user) return unauthorized(c);

    const adaptationId = toInt(c.req.param('adaptationId'));
    if (adaptationId === null || adaptationId < 1) {
      return c.json({ error: 'adaptationId must be a positive integer.' }, 400);
    }
    const body = await parseJsonBody(c);
    const choice = body['choice'] as PollChoice | undefined;
    if (!choice || !POLL_CHOICES.includes(choice)) {
      return c.json(
        { error: "choice must be one of 'book', 'screen', 'both', 'undecided'." },
        400,
      );
    }
    const adaptation = await getAdaptationSummary(c.env.DB, adaptationId);
    if (!adaptation) {
      return c.json({ error: 'Adaptation not found.' }, 404);
    }
    if (!(await checkPollsRate(c.env.DB, user.id))) {
      return c.json({ error: 'Poll vote limit reached — 30 per hour.' }, 429);
    }
    const results = await setPollVote(c.env.DB, user.id, adaptationId, choice);
    return c.json({ ...results, userChoice: choice });
  });
}
