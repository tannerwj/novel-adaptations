// src/hype/routes.ts — hype meter API for unreleased screen works.
//
//   GET    /api/hype?screen_work_id=1 — public summary {average, count, userLevel}
//   POST   /api/hype {screen_work_id, level} — set/change your hype (auth)
//
// DESIGN CHOICE: the server does NOT enforce unreleased-ness on writes. The
// hype widget is simply never rendered for released works (Track 1 ratings
// own that space), so there is no legitimate UI path to hype a released
// title. Keeping the API permissive avoids a second source of truth for
// "is it out yet" and lets release_date corrections flow through the UI
// naturally without stranding users' data.

import type { Context, Hono } from 'hono';
import { getScreenWork } from '../db';
import { getUser, requireUser, type SessionUser } from '../auth/session';
import {
  checkHypeRate,
  getHypeSummary,
  getUserHype,
  setHype,
  MAX_HYPE_PER_HOUR,
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

export function mountHype<E extends { DB: D1Database }>(
  app: Hono<{ Bindings: E }>,
): void {
  // Public: aggregate hype + the viewer's own level. Never 401s — anonymous
  // users get userLevel: null and see the aggregate plus a sign-in prompt.
  app.get('/api/hype', async (c) => {
    const screenWorkId = toInt(c.req.query('screen_work_id'));
    if (screenWorkId === null || screenWorkId < 1) {
      return c.json({ error: 'screen_work_id must be a positive integer.' }, 400);
    }
    const work = await getScreenWork(c.env.DB, screenWorkId);
    if (!work) {
      return c.json({ error: 'Screen work not found.' }, 404);
    }
    const user = await getUser(c);
    const summary = await getHypeSummary(c.env.DB, screenWorkId);
    const userLevel = user
      ? await getUserHype(c.env.DB, user.id, screenWorkId)
      : null;
    return c.json({
      average: summary.average,
      count: summary.count,
      userLevel,
    });
  });

  app.post('/api/hype', async (c) => {
    const user: SessionUser | null = await requireUser(c);
    if (!user) {
      return c.json({ error: 'Sign in to set your hype.' }, 401);
    }

    const body = await parseJsonBody(c);
    const screenWorkId = toInt(body['screen_work_id']);
    const level = toInt(body['level']);
    if (screenWorkId === null || screenWorkId < 1) {
      return c.json({ error: 'screen_work_id must be a positive integer.' }, 400);
    }
    if (level === null || level < 1 || level > 5) {
      return c.json({ error: 'level must be an integer from 1 to 5.' }, 400);
    }
    const work = await getScreenWork(c.env.DB, screenWorkId);
    if (!work) {
      return c.json({ error: 'Screen work not found.' }, 404);
    }
    if (!(await checkHypeRate(c.env.DB, user.id))) {
      return c.json(
        { error: `Slow down — ${MAX_HYPE_PER_HOUR} hype changes per hour.` },
        429,
      );
    }
    const summary = await setHype(c.env.DB, user.id, screenWorkId, level);
    return c.json({
      average: summary.average,
      count: summary.count,
      userLevel: level,
    });
  });
}
