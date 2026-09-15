// src/feedback/routes.ts — Track D: public feedback submission + admin triage.
//
//   GET  /feedback                — feedback form (optional ?type=&subject= prefills)
//   POST /api/feedback            — plain form POST → validation → rate limit → thanks page
//   GET  /admin/feedback          — admin triage queue (?type=&status= filters)
//   POST /api/feedback/:id/status — admin triage action (JSON)
//
// AUTH: anonymous submission is allowed on /api/feedback (no login wall);
// spam protection is the 5/hour/IP rate limit. /admin/feedback and
// /api/feedback/:id/status are gated behind admin sessions
// (requireAdminPage → 303/403, requireAdminApi → 403 JSON), fail closed.

import type { Hono } from 'hono';
import type { Env } from '../index';
import { themeOf } from '../ui';
import { getUser, requireAdminApi, requireAdminPage } from '../auth/session';
import {
  checkFeedbackRate,
  clientIp,
  countFeedbackByStatus,
  createFeedback,
  FEEDBACK_STATUSES,
  FEEDBACK_TYPES,
  getFeedback,
  listFeedback,
  setFeedbackStatus,
  type FeedbackStatus,
  type FeedbackType,
} from './db';
import {
  AdminFeedbackPage,
  FeedbackPage,
  FeedbackThanksPage,
  type AuthUserView,
  type FeedbackFormValues,
} from './pages';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/\S+$/i;

const SUBJECT_MIN = 3;
const SUBJECT_MAX = 120;
const BODY_MIN = 10;
const BODY_MAX = 5000;

function isFeedbackType(v: unknown): v is FeedbackType {
  return typeof v === 'string' && (FEEDBACK_TYPES as string[]).includes(v);
}

function isTriageStatus(v: unknown): v is Extract<FeedbackStatus, 'reviewed' | 'done'> {
  return v === 'reviewed' || v === 'done';
}

/** Project a SessionUser into the shape pages/header consume (mirrors index.tsx). */
function toAuthUser(user: { email: string; isAdmin: boolean } | null): AuthUserView | null {
  return user ? { email: user.email, isAdmin: user.isAdmin } : null;
}

export function mountFeedback<E extends Env>(app: Hono<{ Bindings: E }>): void {
  // Admin gates are attached per-route (not via app.use wildcard prefixes):
  // /admin/feedback is a page (requireAdminPage → 303 to /auth/login when
  // logged out, 403 when non-admin); /api/feedback/:id/status answers 403
  // JSON for non-admins. Fail closed.

  app.get('/feedback', async (c) => {
    const user = toAuthUser(await getUser(c));
    const rawType = c.req.query('type');
    const prefillType = isFeedbackType(rawType) ? rawType : undefined;
    const prefillSubject = c.req.query('subject') ?? undefined;
    return c.html(
      FeedbackPage({ user, prefillType, prefillSubject, theme: themeOf(c) }),
    );
  });

  app.post('/api/feedback', async (c) => {
    let body: Record<string, string | File>;
    try {
      body = await c.req.parseBody();
    } catch {
      body = {};
    }
    const str = (k: string): string => {
      const v = body[k];
      return typeof v === 'string' ? v.trim() : '';
    };
    const values: FeedbackFormValues = {
      type: str('type'),
      subject: str('subject'),
      body: str('body'),
      proofUrl: str('proof_url'),
      email: str('email'),
    };
    const sessionUser = await getUser(c);
    const user = toAuthUser(sessionUser);

    const invalid = (message: string, status: 400 | 422 | 429 = 422) =>
      c.html(FeedbackPage({ user, error: message, values, theme: themeOf(c) }), status);

    if (!isFeedbackType(values.type)) {
      return invalid(
        `Pick one of: ${FEEDBACK_TYPES.join(', ')}.`,
        400,
      );
    }
    if (values.subject.length < SUBJECT_MIN || values.subject.length > SUBJECT_MAX) {
      return invalid(
        `Subject must be ${SUBJECT_MIN}–${SUBJECT_MAX} characters (yours is ${values.subject.length}).`,
      );
    }
    if (values.body.length < BODY_MIN || values.body.length > BODY_MAX) {
      return invalid(
        `Details must be ${BODY_MIN}–${BODY_MAX} characters (yours is ${values.body.length}).`,
      );
    }
    if (values.proofUrl && !URL_RE.test(values.proofUrl)) {
      return invalid('Proof URL must start with http:// or https://.');
    }
    if (values.email && !EMAIL_RE.test(values.email)) {
      return invalid('That email address doesn’t look valid.');
    }

    if (!(await checkFeedbackRate(c.env.DB, clientIp(c.req.raw.headers)))) {
      return invalid('Too many submissions — try again in an hour.', 429);
    }

    await createFeedback(c.env.DB, {
      userId: sessionUser ? sessionUser.id : null,
      email: values.email || null,
      type: values.type,
      subject: values.subject,
      body: values.body,
      proofUrl: values.proofUrl || null,
    });
    return c.html(FeedbackThanksPage({ user, theme: themeOf(c) }));
  });

  app.get('/admin/feedback', requireAdminPage, async (c) => {
    const rawType = c.req.query('type');
    const rawStatus = c.req.query('status');
    const type = isFeedbackType(rawType) ? rawType : undefined;
    const status: FeedbackStatus | undefined = (
      FEEDBACK_STATUSES as string[]
    ).includes(rawStatus ?? '')
      ? (rawStatus as FeedbackStatus)
      : undefined;
    const [items, counts] = await Promise.all([
      listFeedback(c.env.DB, { type, status }),
      countFeedbackByStatus(c.env.DB),
    ]);
    return c.html(
      AdminFeedbackPage({ items, type, status, counts, theme: themeOf(c) }),
    );
  });

  app.post('/api/feedback/:id/status', requireAdminApi, async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: 'invalid feedback id' }, 400);
    }
    let payload: Record<string, unknown>;
    try {
      const b = await c.req.json();
      payload = typeof b === 'object' && b !== null ? (b as Record<string, unknown>) : {};
    } catch {
      return c.json({ error: 'JSON body with a status field is required' }, 400);
    }
    if (!isTriageStatus(payload.status)) {
      return c.json(
        { error: "invalid status; must be 'reviewed' or 'done'" },
        400,
      );
    }
    const item = await getFeedback(c.env.DB, id);
    if (!item) {
      return c.json({ error: `feedback ${id} not found` }, 404);
    }
    await setFeedbackStatus(c.env.DB, id, payload.status);
    return c.json({ ok: true, id, status: payload.status });
  });
}
