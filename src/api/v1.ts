// src/api/v1.ts — versioned JSON API for the client-rendered SPA
// (Phase 1 of the SSR→SPA conversion). Mounted at /api/v1 via mountV1() in
// src/index.tsx.
//
// The existing unversioned /api/* routes and all SSR pages are untouched;
// this file only ADDS routes. Behavior mirrors the existing handlers (same
// db helpers, same rate limits); the differences are the v1 conventions:
//
//   - snake_case JSON keys everywhere
//   - the standard error envelope { error: { code, message } } (docs/API.md)
//   - validation failures always answer 422 (validation_error)
//   - paginated lists answer { data, page, per_page, total }
//
// The contract is documented in docs/API.md — keep the two in sync.

import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Env } from '../index';
import { getUser, SESSION_COOKIE, type SessionUser } from '../auth/session';
import { sha256Hex } from '../auth/crypto';
import {
  checkMagicLinkRate,
  consumeMagicToken,
  issueMagicLink,
  promoteAdmin,
} from '../auth/api';
import { THEME_COOKIE } from '../theme';
import {
  ADAPTATION_STATUSES,
  countNewsByStatus,
  getAdaptationSummary,
  getBook,
  getBookAdaptations,
  getNewsItem,
  getScreenWork,
  getScreenWorkNews,
  idForSlug,
  listNewsItems,
  nextStatusAfter,
  promoteNewsItem,
  releasedAdaptationsViolatedByDate,
  SELECT_ADAPTATION_SUMMARY,
  setNewsItemStatus,
  type AdaptationSummary,
  type NewsItem,
  type NewsStatus,
} from '../db';
import {
  adaptationTimelineStatement,
  bookVoteStateStatement,
  getBookVoteState,
  type TimelineEvent,
} from '../votes/detail';
import {
  castVote,
  checkVoteRate,
  getShelf,
  hasVoted,
  listShelves,
  mostWantedFromRows,
  mostWantedStatements,
  removeShelf,
  shelfStatement,
  SHELF_TARGET_TYPES,
  SHELVES,
  upsertShelf,
  withdrawVote,
  type MostWantedRawRow,
  type ShelfName,
  type ShelfTargetType,
} from '../votes/db';
import {
  checkRatingsRate,
  getRatingSummary,
  getUserRating,
  MAX_RATINGS_PER_HOUR,
  RATING_TARGET_TYPES,
  setRating,
  type RatingTargetType,
} from '../ratings/db';
import {
  checkReviewsRate,
  createReview,
  deleteReview,
  getReview,
  getUserReview,
  listReviewsPage,
  MAX_REVIEWS_PER_HOUR,
  publicDisplayName,
  REVIEW_TARGET_TYPES,
  updateReview,
  type Review,
  type ReviewTargetType,
} from '../reviews/db';
import { BODY_MAX, TITLE_MAX } from '../reviews/db';
import {
  checkPollsRate,
  getPollResults,
  getUserChoice,
  MAX_POLLS_PER_HOUR,
  POLL_CHOICES,
  pollResultsFromRows,
  pollResultsStatement,
  setPollVote,
  userChoiceStatement,
  type PollChoice,
  type PollRow,
} from '../polls/db';
import {
  checkHypeRate,
  getHypeSummary,
  getUserHype,
  isUnreleased,
  MAX_HYPE_PER_HOUR,
  setHype,
} from '../hype/db';
import {
  addItem,
  checkListRate,
  createList,
  deleteList,
  getListById,
  getListBySlug,
  listListItems,
  listPublicLists,
  listUserLists,
  LIST_TARGET_TYPES,
  MAX_LISTS_PER_HOUR,
  removeItem,
  reorderItems,
  updateList,
  type ListItemView,
  type ListTargetType,
  type UserListSummary,
} from '../lists/db';
import { purgeListPreview } from '../prerender';
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
} from '../feedback/db';
import { listPipelineRuns } from '../news/ingest';
import {
  flagEnrichmentForAdaptation,
  listScreenWorksForAdmin,
  validateReleaseDate,
} from '../news/curation_db';
import { countRemaining, countRemainingFull, parseBatchSize, runEnrichmentBatch, runFullBatch } from '../enrichment';
import {
  getPopularBooks,
  RESULT_LIMIT,
  searchStatements,
  type AdaptationHit,
  type BookHit,
  type ScreenWorkHit,
} from '../search_db';
import {
  getCalendarFeed,
  getEarlierWorksForYear,
  recentWindowStart,
} from '../calendar_db';
import { getWatchProviders } from '../watch_providers_cache';
import { fetchAndCacheProviders } from '../watch_providers_cache';
import { IntakeError, intakeFromTip } from '../intake';
import { submitIndexNow } from '../indexnow';
import { fetchTrailerKey } from '../trailers';

const v1 = new Hono<{ Bindings: Env }>();

// --- Phase 4 (observability): one cheap JSON log line per /api/v1 request.
// Registered on the v1 sub-app only, so page shells, static assets, the SEO
// routes, and the cron internals (which never touch HTTP) stay silent. No
// request/response bodies, no PII — just method, route, status, duration.
v1.use(async (c, next) => {
  const start = Date.now();
  await next();
  console.log(JSON.stringify({
    method: c.req.method,
    route: c.req.path,
    status: c.res.status,
    ms: Date.now() - start,
  }));
});

type V1Context = Context<{ Bindings: Env }>;

/** The public shape of the logged-in user (docs/API.md § Auth). */
export interface V1User {
  id: number;
  email: string;
  is_admin: boolean;
}

// --- shared primitives -------------------------------------------------------

type ErrorStatus = 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503;

/** Standard error envelope: { error: { code, message } }. */
function apiError(c: V1Context, status: ErrorStatus, code: string, message: string) {
  return c.json({ error: { code, message } }, status);
}

const validationError = (c: V1Context, message: string) =>
  apiError(c, 422, 'validation_error', message);

const unauthorized = (c: V1Context, message = 'Sign in to continue.') =>
  apiError(c, 401, 'unauthorized', message);

async function parseJsonBody(c: V1Context): Promise<Record<string, unknown>> {
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

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Resolve a detail-route `:idOrSlug` param to a numeric row id. All-digit
 * params are legacy numeric URLs; anything else is looked up as a slug.
 * Returns null when the param is neither (→ 404 downstream).
 */
async function resolveDetailId(
  db: D1Database,
  table: 'books' | 'screen_works' | 'adaptations',
  param: string,
): Promise<number | null> {
  if (/^\d+$/.test(param)) {
    const id = Number(param);
    return Number.isSafeInteger(id) && id >= 1 ? id : null;
  }
  if (!/^[a-z0-9-]{1,120}$/.test(param)) return null;
  return idForSlug(db, table, param);
}

/** ?page=&per_page= → { page, per_page, offset }. Clamps per_page to 100. */
function pagination(
  c: V1Context,
  defaultPerPage: number,
): { page: number; per_page: number; offset: number } {
  const rawPage = Number(c.req.query('page'));
  const rawPer = Number(c.req.query('per_page'));
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const perPageRaw = Number.isInteger(rawPer) && rawPer > 0 ? rawPer : defaultPerPage;
  const per_page = Math.min(perPageRaw, 100);
  return { page, per_page, offset: (page - 1) * per_page };
}

/** Slice a full result array into the { data, page, per_page, total } shape. */
function paginate<T>(
  rows: T[],
  page: number,
  per_page: number,
  total?: number,
): { data: T[]; page: number; per_page: number; total: number } {
  const offset = (page - 1) * per_page;
  return {
    data: rows.slice(offset, offset + per_page),
    page,
    per_page,
    total: total ?? rows.length,
  };
}

/** The session user projected into the v1 user shape, or null. */
async function v1User(c: V1Context): Promise<V1User | null> {
  const u: SessionUser | null = await getUser(c);
  return u ? toV1User(u.id, u.email, u.isAdmin) : null;
}

/** Normalize the D1 0/1 is_admin into a real boolean. */
function toV1User(id: number, email: string, isAdmin: unknown): V1User {
  return { id, email, is_admin: isAdmin === 1 || isAdmin === true };
}

/**
 * Short-TTL edge caching for anonymous, non-personalized GETs (home,
 * calendar, search) — see edgeCached. Responses carry `public, s-maxage=60`
 * so the edge serves repeat hits without a D1 round trip.
 *
 * Deliberately NOT applied to /most-wanted or /adaptations/:id: those carry
 * user_voted / user_shelf / user_choice fields when a session cookie is
 * present, and the edge cache key does not vary on cookies — caching them
 * would leak one user's personalized state to another visitor. Correctness
 * over speed there (they still get the D1 batching below).
 */
/**
 * Serve a fully-public GET response from the edge cache (Workers Cache API),
 * building + storing it on a miss. Keyed on the full request URL (query
 * included), so /search?q=... variants and ?page= pages don't collide.
 *
 * Why the Cache API and not bare Cache-Control headers: on this zone
 * Cloudflare's CDN does not evaluate Worker-generated JSON responses for
 * edge caching from headers alone (verified live: header-only responses come
 * back with no cf-cache-status at all, while static assets HIT). The worker
 * therefore writes the entry explicitly. The stored response still carries
 * `public, s-maxage=60, max-age=30`, which bounds the entry's TTL and lets
 * browsers cache briefly too.
 *
 * ONLY for responses that are byte-identical for every visitor (no user
 * fields). /most-wanted and /adaptations/:id are deliberately excluded:
 * user_voted / user_shelf / user_choice are personalized when logged in, and
 * the edge cache key does not vary on cookies — caching them would leak one
 * user's state to another visitor. Correctness over speed there.
 */
async function edgeCached(
  c: V1Context,
  build: () => Promise<Response>,
): Promise<Response> {
  const key = new Request(c.req.url, { method: 'GET' });
  const hit = await caches.default.match(key);
  if (hit) {
    // Cached responses have immutable headers — clone to stamp the header.
    const h = new Response(hit.body, hit);
    h.headers.set('X-Edge-Cache', 'HIT');
    return h;
  }
  const res = await build();
  if (res.status !== 200) return res;
  const out = new Response(res.body, res);
  out.headers.set('Cache-Control', 'public, s-maxage=60, max-age=30');
  out.headers.set('X-Edge-Cache', 'MISS');
  c.executionCtx.waitUntil(
    caches.default.put(key, out.clone()).catch((e) => {
      console.error('edge cache put failed:', (e as Error).message);
    }),
  );
  return out;
}

/**
 * db.batch() resolves exactly one D1Result per statement, in order.
 * noUncheckedIndexedAccess flags every array destructure, so call sites use
 * this instead of `const [a, b] = ...`.
 */
function batched(results: D1Result[], i: number): D1Result {
  const r = results[i];
  if (!r) throw new Error(`D1 batch result ${i} missing`);
  return r;
}

// --- row → JSON projections (snake_case) -------------------------------------

function reviewToJson(r: Review) {
  return {
    id: r.id,
    user_id: r.userId,
    target_type: r.targetType,
    target_id: r.targetId,
    title: r.title,
    body: r.body,
    has_spoilers: r.hasSpoilers,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
    author_id: r.authorId,
    author_name: publicDisplayName(r.authorEmail),
  };
}

function newsToJson(n: NewsItem) {
  return {
    ...n,
    is_adaptation_news: n.is_adaptation_news === 1,
    needs_review: n.needs_review === 1,
  };
}

function listToJson(l: UserListSummary) {
  return {
    id: l.id,
    title: l.title,
    description: l.description,
    is_public: l.is_public === 1,
    slug: l.slug,
    item_count: l.itemCount,
    created_at: l.created_at,
    updated_at: l.updated_at,
  };
}

function listItemToJson(i: ListItemView) {
  return {
    id: i.id,
    target_type: i.targetType,
    target_id: i.targetId,
    position: i.position,
    note: i.note,
    title: i.title,
    subtitle: i.subtitle,
    image_url: i.imageUrl,
    href: i.href,
  };
}

// --- cookies -----------------------------------------------------------------

const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30 days, mirrors src/auth/routes.ts

function setSessionCookie(c: V1Context, token: string): void {
  const secure = new URL(c.req.url).protocol === 'https:';
  setCookie(c, SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure,
    maxAge: SESSION_MAX_AGE,
  });
}

/** 1-year theme cookie; shared across apex/www on the production domain. */
function setThemeCookie(c: V1Context, theme: 'light' | 'dark'): void {
  const host = new URL(c.req.url).hostname;
  const sharedDomain =
    host === 'noveladaptations.com' || host === 'www.noveladaptations.com'
      ? 'noveladaptations.com'
      : undefined;
  setCookie(c, THEME_COOKIE, theme, {
    path: '/',
    maxAge: 31536000,
    sameSite: 'Lax',
    ...(sharedDomain ? { domain: sharedDomain } : {}),
  });
}

// --- auth --------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

v1.post('/auth/magic-link', async (c) => {
  const body = await parseJsonBody(c);
  const email = str(body['email']).toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return validationError(c, 'Enter a valid email address.');
  }
  if (!(await checkMagicLinkRate(c.env.DB, email, clientIp(c.req.raw.headers)))) {
    return apiError(
      c,
      429,
      'rate_limited',
      'Too many sign-in emails — try again in an hour.',
    );
  }
  const origin = new URL(c.req.url).origin;
  const { sent, link } = await issueMagicLink(c.env.DB, c.env, email, origin);
  if (sent) return c.json({ ok: true, email });
  // Fail closed: the dev link is a local-dev convenience ONLY (same rule as
  // the legacy HTML route).
  const devMode = c.env.ENVIRONMENT === 'development' || c.env.ENVIRONMENT === 'preview';
  if (devMode) return c.json({ ok: true, email, dev_link: link });
  return apiError(
    c,
    503,
    'email_not_configured',
    'Sign-in email is not configured yet. Ask the site owner to onboard a sending domain in Email Service.',
  );
});

v1.post('/auth/verify', async (c) => {
  const body = await parseJsonBody(c);
  const token = typeof body['token'] === 'string' ? body['token'] : '';
  if (!token) return validationError(c, 'A token is required.');
  const consumed = await consumeMagicToken(c.env.DB, token);
  if (!consumed) {
    return apiError(
      c,
      401,
      'invalid_token',
      'This sign-in link is invalid, expired, or already used.',
    );
  }
  // Admin bootstrap — the ONLY promotion path (mirrors GET /auth/verify).
  await promoteAdmin(c.env.DB, c.env.ADMIN_EMAILS, consumed.userId);
  setSessionCookie(c, consumed.sessionToken);
  const row = await c.env.DB
    .prepare('SELECT id, email, is_admin FROM users WHERE id = ?1')
    .bind(consumed.userId)
    .first<{ id: number; email: string; is_admin: number }>();
  const user: V1User | null = row ? toV1User(row.id, row.email, row.is_admin) : null;
  return c.json({ user });
});

v1.get('/auth/me', async (c) => {
  const user = await v1User(c);
  if (!user) return unauthorized(c);
  return c.json({ user });
});

v1.post('/auth/logout', async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const tokenHash = await sha256Hex(token);
    await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1')
      .bind(tokenHash)
      .run();
  }
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ ok: true });
});

// --- home / adaptations ------------------------------------------------------

/** Shared query parsing for the adaptation list endpoints. */
/** Pre-release pipeline statuses behind the virtual `status=upcoming` filter. */
const UPCOMING_STATUSES = ['rumored', 'optioned', 'in_development', 'filming', 'post_production'];

const SCREEN_KINDS = ['film', 'series'] as const;

/**
 * Shared kind/status filter parsing for the adaptation list and search
 * endpoints. `status=upcoming` expands to the pre-release pipeline set.
 */
function parseKindStatusFilter(c: V1Context):
  | { ok: true; statuses: string[]; kind?: string }
  | { ok: false; response: Response } {
  const rawStatus = c.req.query('status');
  let statuses: string[] = [];
  if (rawStatus === 'upcoming') {
    statuses = [...UPCOMING_STATUSES];
  } else if (rawStatus) {
    if (!(ADAPTATION_STATUSES as readonly string[]).includes(rawStatus)) {
      return {
        ok: false,
        response: validationError(
          c,
          `status must be one of: ${ADAPTATION_STATUSES.join(', ')}, upcoming.`,
        ),
      };
    }
    statuses = [rawStatus];
  }
  const rawKind = c.req.query('kind');
  let kind: string | undefined;
  if (rawKind) {
    if (!(SCREEN_KINDS as readonly string[]).includes(rawKind)) {
      return {
        ok: false,
        response: validationError(c, `kind must be one of: ${SCREEN_KINDS.join(', ')}.`),
      };
    }
    kind = rawKind;
  }
  return { ok: true, statuses, kind };
}

/**
 * WHERE fragment for adaptation-list queries. SELECT_ADAPTATION_SUMMARY
 * exposes the adaptations table as `a` and screen_works as `s`, so kind and
 * status filters apply in SQL before LIMIT — the client never pages past
 * rows it will discard.
 */
function adaptationFilterWhere(
  statuses: string[],
  kind?: string,
): { where: string; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (statuses.length > 0) {
    conds.push(`a.status IN (${statuses.map(() => '?').join(', ')})`);
    params.push(...statuses);
  }
  if (kind) {
    conds.push('s.kind = ?');
    params.push(kind);
  }
  return { where: conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '', params };
}

function parseAdaptationListQuery(
  c: V1Context,
):
  | { ok: true; page: number; per_page: number; statuses: string[]; kind?: string; newest: boolean }
  | { ok: false; response: Response } {
  const { page, per_page } = pagination(c, 24);
  const f = parseKindStatusFilter(c);
  if (!f.ok) return f;
  // Additive, opt-in sort: `sort=newest` orders newest records first.
  // Anything else is a 422 — the query is part of the public API contract.
  const rawSort = c.req.query('sort');
  if (rawSort && rawSort !== 'newest') {
    return {
      ok: false,
      response: validationError(c, "sort must be 'newest'."),
    };
  }
  return {
    ok: true,
    page,
    per_page,
    statuses: f.statuses,
    kind: f.kind,
    newest: rawSort === 'newest',
  };
}

async function adaptationListData(c: V1Context) {
  const q = parseAdaptationListQuery(c);
  if (!q.ok) return q;
  // Paginate in SQL so D1 ships one page of rows, not the whole catalog.
  // Kind/status filters also apply in SQL, so the count matches the rows
  // and no page is wasted on rows the client would discard.
  const offset = (q.page - 1) * q.per_page;
  const orderBy = q.newest ? 'ORDER BY a.id DESC' : 'ORDER BY a.id ASC';
  const { where, params } = adaptationFilterWhere(q.statuses, q.kind);
  const listStmt = c.env.DB.prepare(
    `${SELECT_ADAPTATION_SUMMARY} ${where} ${orderBy} LIMIT ? OFFSET ?`,
  ).bind(...params, q.per_page, offset);
  const countStmt = c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM adaptations a JOIN screen_works s ON s.id = a.screen_work_id ${where}`,
  ).bind(...params);
  const batchRes = await c.env.DB.batch([listStmt, countStmt]);
  const listRes = batched(batchRes, 0);
  const countRes = batched(batchRes, 1);
  const rows = (listRes.results ?? []) as AdaptationSummary[];
  const total = (countRes.results?.[0] as { n: number } | undefined)?.n ?? 0;
  return { ok: true as const, list: { data: rows, page: q.page, per_page: q.per_page, total } };
}

v1.get('/home', async (c) => {
  const q = parseAdaptationListQuery(c);
  if (!q.ok) return q.response;
  return edgeCached(c, async () => {
    // One D1 round trip: a single page of the adaptation list (+ its
    // filtered total for pagination) and the four stat counts. The list
    // query is paginated in SQL — D1 ships 24 rows, not all 1,249.
    const offset = (q.page - 1) * q.per_page;
    const orderBy = q.newest ? 'ORDER BY a.id DESC' : 'ORDER BY a.id ASC';
    const { where, params } = adaptationFilterWhere(q.statuses, q.kind);
    const listStmt = c.env.DB.prepare(
      `${SELECT_ADAPTATION_SUMMARY} ${where} ${orderBy} LIMIT ? OFFSET ?`,
    ).bind(...params, q.per_page, offset);
    const listCountStmt = c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM adaptations a JOIN screen_works s ON s.id = a.screen_work_id ${where}`,
    ).bind(...params);
    const homeBatch = await c.env.DB.batch([
      listStmt,
      listCountStmt,
      // stats.total_adaptations is always the unfiltered catalog size.
      c.env.DB.prepare('SELECT COUNT(*) AS n FROM adaptations'),
      c.env.DB.prepare('SELECT COUNT(*) AS n FROM books'),
      c.env.DB.prepare('SELECT COUNT(*) AS n FROM screen_works'),
      c.env.DB.prepare("SELECT COUNT(*) AS n FROM news_items WHERE status = 'approved'"),
    ]);
    const listRes = batched(homeBatch, 0);
    const listCountRes = batched(homeBatch, 1);
    const adaptationsRes = batched(homeBatch, 2);
    const booksRes = batched(homeBatch, 3);
    const worksRes = batched(homeBatch, 4);
    const newsRes = batched(homeBatch, 5);
    const count = (r: D1Result) => (r.results?.[0] as { n: number } | undefined)?.n ?? 0;
    const adaptations = (listRes.results ?? []) as AdaptationSummary[];
    return c.json({
      adaptations: {
        data: adaptations,
        page: q.page,
        per_page: q.per_page,
        total: count(listCountRes),
      },
      stats: {
        total_adaptations: count(adaptationsRes),
        total_books: count(booksRes),
        total_screen_works: count(worksRes),
        approved_news: count(newsRes),
      },
    });
  });
});

v1.get('/adaptations', async (c) => {
  const data = await adaptationListData(c);
  if (!data.ok) return data.response;
  return c.json(data.list);
});

/**
 * Featured rail for the home landing page. No curation data exists on the
 * site — this is derived from REAL signals only: adaptations whose screen
 * work has actual poster art (TMDB enrichment backfill), ordered by the
 * community vote count on the source book, then newest release date, then
 * newest catalog record. Fixed small LIMIT in SQL (clamped to 24), so the
 * client never pulls the catalog. Identical for every visitor — edge-cached.
 */
v1.get('/home/featured', async (c) => {
  const rawLimit = Number(c.req.query('limit'));
  let limit = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : 12;
  limit = Math.min(limit, 24);
  return edgeCached(c, async () => {
    // SELECT_ADAPTATION_SUMMARY ends with its FROM/JOINs, so wrap it and
    // project the vote count on top — the shared constant stays intact.
    const { results } = await c.env.DB
      .prepare(
        `SELECT x.*, COALESCE(v.votes, 0) AS book_votes
         FROM (${SELECT_ADAPTATION_SUMMARY}) x
         LEFT JOIN (SELECT book_id, COUNT(*) AS votes FROM votes GROUP BY book_id) v
           ON v.book_id = x.book_id
         WHERE x.screen_poster_url IS NOT NULL AND x.screen_poster_url != ''
         ORDER BY book_votes DESC,
                  x.screen_release_date IS NULL,
                  x.screen_release_date DESC,
                  x.id DESC
         LIMIT ?1`,
      )
      .bind(limit)
      .all<AdaptationSummary & { book_votes: number }>();
    const data = results ?? [];
    return c.json({ data, limit, total: data.length });
  });
});

v1.get('/adaptations/:idOrSlug', async (c) => {
  const id = await resolveDetailId(c.env.DB, 'adaptations', c.req.param('idOrSlug'));
  if (id === null) {
    return validationError(c, 'Adaptation not found.');
  }
  // One D1 round trip for the three anonymous queries (was: 1 + 2 more).
  const detailBatch = await c.env.DB.batch([
    c.env.DB.prepare(`${SELECT_ADAPTATION_SUMMARY} WHERE a.id = ?1`).bind(id),
    adaptationTimelineStatement(c.env.DB, id),
    pollResultsStatement(c.env.DB, id),
  ]);
  const summaryRes = batched(detailBatch, 0);
  const timelineRes = batched(detailBatch, 1);
  const pollRes = batched(detailBatch, 2);
  const adaptation = (summaryRes.results?.[0] ?? null) as AdaptationSummary | null;
  if (!adaptation) return apiError(c, 404, 'not_found', 'Adaptation not found.');
  const user = await v1User(c);
  // Preserve getAdaptationTimeline's legacy-seed fallback (no audit rows →
  // synthesize one event from the current status); the extra lookup it used
  // to do is redundant now that we already hold the summary row.
  let timeline = ((timelineRes.results ?? []) as TimelineEvent[]).map((t) => ({
    status: t.status,
    at: t.at,
    source_url: t.sourceUrl,
  }));
  if (timeline.length === 0) {
    timeline = [{ status: adaptation.status, at: null, source_url: adaptation.source_url }];
  }
  const pollResults = pollResultsFromRows((pollRes.results ?? []) as PollRow[]);
  const [userVoted, userShelf, userChoice] = user
    ? await (async () => {
        // One D1 round trip for the three per-user lookups (was: three).
        const userBatch = await c.env.DB.batch([
          bookVoteStateStatement(c.env.DB, user.id, adaptation.book_id),
          shelfStatement(c.env.DB, user.id, 'adaptation', id),
          userChoiceStatement(c.env.DB, user.id, id),
        ]);
        const voteRes = batched(userBatch, 0);
        const shelfRes = batched(userBatch, 1);
        const choiceRes = batched(userBatch, 2);
        return [
          (voteRes.results?.length ?? 0) > 0,
          (shelfRes.results?.[0] as { shelf: ShelfName } | undefined)?.shelf ?? null,
          (choiceRes.results?.[0] as { choice: PollChoice } | undefined)?.choice ?? null,
        ] as const;
      })()
    : [false, null, null];
  // NOT edge-cached: user_voted / user_shelf / user_choice are personalized
  // when logged in, and the edge cache key doesn't vary on cookies (see
  // edgeCached). The D1 batching above is the whole win here.
  return c.json({
    adaptation,
    timeline,
    user_voted: userVoted,
    user_shelf: userShelf,
    poll: {
      adaptation_id: id,
      counts: pollResults.counts,
      total: pollResults.total,
      user_choice: userChoice,
    },
  });
});

// --- books -------------------------------------------------------------------

v1.get('/books/:idOrSlug', async (c) => {
  const id = await resolveDetailId(c.env.DB, 'books', c.req.param('idOrSlug'));
  if (id === null) {
    return validationError(c, 'Book not found.');
  }
  const book = await getBook(c.env.DB, id);
  if (!book) return apiError(c, 404, 'not_found', 'Book not found.');
  const user = await v1User(c);
  const [adaptations, ratingSummary] = await Promise.all([
    getBookAdaptations(c.env.DB, id),
    getRatingSummary(c.env.DB, 'book', id),
  ]);
  const [userRating, userVoted, userShelf, userLists] = user
    ? await Promise.all([
        getUserRating(c.env.DB, user.id, 'book', id),
        getBookVoteState(c.env.DB, user.id, id),
        getShelf(c.env.DB, user.id, 'book', id),
        listUserLists(c.env.DB, user.id).then((ls) =>
          ls.map((l) => ({ id: l.id, title: l.title })),
        ),
      ])
    : [null, false, null, []];
  return c.json({
    book,
    adaptations,
    rating: { average: ratingSummary.average, count: ratingSummary.count },
    user_rating: userRating,
    user_voted: userVoted,
    user_shelf: userShelf,
    user_lists: userLists,
  });
});

// --- screen works ("watch") --------------------------------------------------

v1.get('/watch/:idOrSlug', async (c) => {
  const id = await resolveDetailId(c.env.DB, 'screen_works', c.req.param('idOrSlug'));
  if (id === null) {
    return validationError(c, 'Screen work not found.');
  }
  const work = await getScreenWork(c.env.DB, id);
  if (!work) return apiError(c, 404, 'not_found', 'Screen work not found.');
  const user = await v1User(c);
  const [news, providers, ratingSummary] = await Promise.all([
    getScreenWorkNews(
      c.env.DB,
      work.books.map((b) => b.title),
    ),
    // Where-to-watch: 7-day D1 cache; never throws, may be null.
    getWatchProviders(c.env.DB, c.executionCtx, c.env, {
      id: work.id,
      tmdb_id: work.tmdb_id,
      kind: work.kind,
    }),
    getRatingSummary(c.env.DB, 'screen_work', id),
  ]);
  const showHype = isUnreleased(work.release_date);
  const [userRating, hypeSummary, userHype, userLists] = await Promise.all([
    user ? getUserRating(c.env.DB, user.id, 'screen_work', id) : Promise.resolve(null),
    showHype ? getHypeSummary(c.env.DB, id) : Promise.resolve(null),
    showHype && user ? getUserHype(c.env.DB, user.id, id) : Promise.resolve(null),
    user
      ? listUserLists(c.env.DB, user.id).then((ls) =>
          ls.map((l) => ({ id: l.id, title: l.title })),
        )
      : Promise.resolve([]),
  ]);
  return c.json({
    work,
    news: news.map(newsToJson),
    watch_providers: providers,
    rating: { average: ratingSummary.average, count: ratingSummary.count },
    user_rating: userRating,
    hype: hypeSummary
      ? { average: hypeSummary.average, count: hypeSummary.count, user_level: userHype }
      : null,
    user_lists: userLists,
  });
});

// Trailer key for a screen work. The TMDB /videos lookup runs at most once
// per title: hits and confirmed misses ('') are cached on
// screen_works.trailer_youtube_key; network/API failures are not cached and
// stay retryable. The TMDB key never leaves the worker — only the YouTube
// video key is returned.
v1.get('/watch/:idOrSlug/trailer', async (c) => {
  const id = await resolveDetailId(c.env.DB, 'screen_works', c.req.param('idOrSlug'));
  if (id === null) return apiError(c, 404, 'not_found', 'Screen work not found.');
  const row = await c.env.DB
    .prepare(
      'SELECT id, tmdb_id, kind, trailer_youtube_key FROM screen_works WHERE id = ?1',
    )
    .bind(id)
    .first<{ id: number; tmdb_id: number | null; kind: string; trailer_youtube_key: string | null }>();
  if (!row) return apiError(c, 404, 'not_found', 'Screen work not found.');
  if (row.trailer_youtube_key !== null) {
    return c.json({ youtube_key: row.trailer_youtube_key || null, cached: true });
  }
  const outcome = await fetchTrailerKey(
    row.tmdb_id ?? 0,
    row.kind === 'series' ? 'series' : 'film',
    c.env.TMDB_API_KEY ?? '',
  );
  if (outcome.status === 'failed' || outcome.status === 'not-attempted') {
    // Don't cache failures — a later click retries.
    return c.json({ youtube_key: null, cached: false });
  }
  const key = outcome.status === 'hit' ? outcome.key : '';
  await c.env.DB
    .prepare('UPDATE screen_works SET trailer_youtube_key = ?1 WHERE id = ?2')
    .bind(key, id)
    .run();
  return c.json({ youtube_key: key || null, cached: false });
});

// --- most wanted & votes -----------------------------------------------------

v1.get('/most-wanted', async (c) => {
  const { page, per_page } = pagination(c, 100);
  const user = await v1User(c);
  // getMostWanted caps at its `limit` and takes no offset, so fetch enough
  // rows for the requested page (bounded at 1000) and count voted books
  // separately for an exact `total` — both in one D1 round trip (was: two).
  const wantedBatch = await c.env.DB.batch(
    mostWantedStatements(c.env.DB, user?.id ?? null, Math.min(1000, page * per_page)),
  );
  const rowsRes = batched(wantedBatch, 0);
  const totalRes = batched(wantedBatch, 1);
  const rows = mostWantedFromRows((rowsRes.results ?? []) as MostWantedRawRow[]);
  const total = (totalRes.results?.[0] as { n: number } | undefined)?.n ?? 0;
  // NOT edge-cached: user_voted is personalized when logged in, and the edge
  // cache key doesn't vary on cookies (see edgeCached).
  return c.json(
    paginate(
      rows.map((r) => ({
        book_id: r.bookId,
        title: r.title,
        authors: r.authors,
        cover_url: r.coverUrl,
        slug: r.slug,
        votes: r.votes,
        user_voted: r.userVoted,
      })),
      page,
      per_page,
      total,
    ),
  );
});

v1.post('/votes', async (c) => {
  const user = await v1User(c);
  if (!user) return unauthorized(c, 'Sign in to vote.');
  const body = await parseJsonBody(c);
  const bookId = toInt(body['book_id']);
  if (bookId === null || bookId < 1) {
    return validationError(c, 'book_id must be a positive integer.');
  }
  const book = await getBook(c.env.DB, bookId);
  if (!book) return apiError(c, 404, 'not_found', 'Book not found.');
  // Idempotent re-vote doesn't consume the daily rate budget.
  if (!(await hasVoted(c.env.DB, user.id, bookId))) {
    if (!(await checkVoteRate(c.env.DB, user.id))) {
      return apiError(c, 429, 'rate_limited', 'Vote limit reached — 20 votes per day.');
    }
  }
  const result = await castVote(c.env.DB, user.id, bookId);
  return c.json({ voted: result.voted, votes: result.votes });
});

v1.delete('/votes/:bookId', async (c) => {
  const user = await v1User(c);
  if (!user) return unauthorized(c, 'Sign in to vote.');
  const bookId = toInt(c.req.param('bookId'));
  if (bookId === null || bookId < 1) {
    return validationError(c, 'book_id must be a positive integer.');
  }
  const result = await withdrawVote(c.env.DB, user.id, bookId);
  return c.json({ voted: result.voted, votes: result.votes });
});

// --- ratings -----------------------------------------------------------------

function parseRatingTarget(c: V1Context): { ok: true; targetType: RatingTargetType; targetId: number } | { ok: false } {
  const rawType = c.req.query('target_type') ?? '';
  const targetId = toInt(c.req.query('target_id'));
  if (
    !RATING_TARGET_TYPES.includes(rawType as RatingTargetType) ||
    targetId === null ||
    targetId < 1
  ) {
    return { ok: false };
  }
  return { ok: true, targetType: rawType as RatingTargetType, targetId };
}

/** Verify the rated target exists (book or screen work). */
async function ratingTargetExists(
  db: D1Database,
  targetType: RatingTargetType,
  targetId: number,
): Promise<boolean> {
  if (targetType === 'book') return (await getBook(db, targetId)) !== null;
  return (await getScreenWork(db, targetId)) !== null;
}

v1.get('/ratings', async (c) => {
  const parsed = parseRatingTarget(c);
  if (!parsed.ok) {
    return validationError(
      c,
      "target_type must be 'book' or 'screen_work', and target_id a positive integer.",
    );
  }
  const { targetType, targetId } = parsed;
  const user = await v1User(c);
  const summary = await getRatingSummary(c.env.DB, targetType, targetId);
  const userRating =
    user === null ? null : await getUserRating(c.env.DB, user.id, targetType, targetId);
  return c.json({
    target_type: targetType,
    target_id: targetId,
    average: summary.average,
    count: summary.count,
    user_rating: userRating,
  });
});

v1.post('/ratings', async (c) => {
  const user = await v1User(c);
  if (!user) return unauthorized(c, 'Sign in to rate.');
  const body = await parseJsonBody(c);
  const targetType = body['target_type'] as RatingTargetType | undefined;
  const targetId = toInt(body['target_id']);
  const rating = toInt(body['rating']);
  if (!targetType || !RATING_TARGET_TYPES.includes(targetType)) {
    return validationError(c, "target_type must be 'book' or 'screen_work'.");
  }
  if (targetId === null || targetId < 1) {
    return validationError(c, 'target_id must be a positive integer.');
  }
  if (rating === null || rating < 1 || rating > 5) {
    return validationError(c, 'rating must be an integer from 1 to 5.');
  }
  if (!(await ratingTargetExists(c.env.DB, targetType, targetId))) {
    return apiError(c, 404, 'not_found', 'Target not found.');
  }
  if (!(await checkRatingsRate(c.env.DB, user.id))) {
    return apiError(
      c,
      429,
      'rate_limited',
      `Rating limit reached — ${MAX_RATINGS_PER_HOUR} ratings per hour.`,
    );
  }
  await setRating(c.env.DB, user.id, targetType, targetId, rating);
  const summary = await getRatingSummary(c.env.DB, targetType, targetId);
  return c.json({
    target_type: targetType,
    target_id: targetId,
    average: summary.average,
    count: summary.count,
    user_rating: rating,
  });
});

// --- reviews -----------------------------------------------------------------

function parseReviewTarget(c: V1Context): { ok: true; targetType: ReviewTargetType; targetId: number } | { ok: false } {
  const rawType = c.req.query('target_type') ?? '';
  const targetId = toInt(c.req.query('target_id'));
  if (
    !(REVIEW_TARGET_TYPES as string[]).includes(rawType) ||
    targetId === null ||
    targetId < 1
  ) {
    return { ok: false };
  }
  return { ok: true, targetType: rawType as ReviewTargetType, targetId };
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

v1.get('/reviews', async (c) => {
  const parsed = parseReviewTarget(c);
  if (!parsed.ok) {
    return validationError(
      c,
      "target_type must be 'book' or 'screen_work', and target_id a positive integer.",
    );
  }
  const { page, per_page } = pagination(c, 20);
  const reviewPage = await listReviewsPage(c.env.DB, parsed.targetType, parsed.targetId, page, per_page);
  // reviewPage.reviews is already the SQL-paginated page — return it directly.
  // (finding 11: slicing it again here emptied page 2+.)
  return c.json({
    target_type: parsed.targetType,
    target_id: parsed.targetId,
    reviews: {
      data: reviewPage.reviews.map(reviewToJson),
      page,
      per_page,
      total: reviewPage.total,
    },
  });
});

v1.post('/reviews', async (c) => {
  const user = await v1User(c);
  if (!user) return unauthorized(c, 'Sign in to write a review.');
  const payload = await parseJsonBody(c);
  const targetType = payload['target_type'];
  const targetId = toInt(payload['target_id']);
  if (!(REVIEW_TARGET_TYPES as string[]).includes(targetType as string)) {
    return validationError(c, "target_type must be 'book' or 'screen_work'.");
  }
  if (targetId === null || targetId < 1) {
    return validationError(c, 'target_id must be a positive integer.');
  }
  const fieldError = invalidReviewFields(payload['body'], payload['title']);
  if (fieldError) return validationError(c, fieldError);
  const exists =
    targetType === 'book'
      ? (await getBook(c.env.DB, targetId)) !== null
      : (await getScreenWork(c.env.DB, targetId)) !== null;
  if (!exists) return apiError(c, 404, 'not_found', 'Target not found.');
  // One review per user per item — edit it instead.
  const existing = await getUserReview(
    c.env.DB,
    user.id,
    targetType as ReviewTargetType,
    targetId,
  );
  if (existing) {
    return c.json(
      {
        error: {
          code: 'conflict',
          message: "You've already reviewed this — edit your existing review instead.",
        },
        review_id: existing.id,
      },
      409,
    );
  }
  if (!(await checkReviewsRate(c.env.DB, user.id))) {
    return apiError(
      c,
      429,
      'rate_limited',
      `Review limit reached — ${MAX_REVIEWS_PER_HOUR} reviews per hour.`,
    );
  }
  const id = await createReview(
    c.env.DB,
    user.id,
    targetType as ReviewTargetType,
    targetId,
    normalizeTitle(payload['title']),
    String(payload['body']).trim(),
    payload['has_spoilers'] === true,
  );
  return c.json({ review: reviewToJson((await getReview(c.env.DB, id))!) }, 201);
});

v1.put('/reviews/:id', async (c) => {
  const user = await v1User(c);
  if (!user) return unauthorized(c, 'Sign in to edit a review.');
  const id = toInt(c.req.param('id'));
  if (id === null || id < 1) {
    return validationError(c, 'Review id must be a positive integer.');
  }
  const review = await getReview(c.env.DB, id);
  if (!review) return apiError(c, 404, 'not_found', 'Review not found.');
  if (review.authorId !== user.id) {
    return apiError(c, 403, 'forbidden', 'You can only edit your own reviews.');
  }
  const payload = await parseJsonBody(c);
  const fieldError = invalidReviewFields(payload['body'], payload['title']);
  if (fieldError) return validationError(c, fieldError);
  await updateReview(
    c.env.DB,
    user.id,
    id,
    normalizeTitle(payload['title']),
    String(payload['body']).trim(),
    payload['has_spoilers'] === true,
  );
  return c.json({ review: reviewToJson((await getReview(c.env.DB, id))!) });
});

v1.delete('/reviews/:id', async (c) => {
  const user = await v1User(c);
  if (!user) return unauthorized(c, 'Sign in to delete a review.');
  const id = toInt(c.req.param('id'));
  if (id === null || id < 1) {
    return validationError(c, 'Review id must be a positive integer.');
  }
  const review = await getReview(c.env.DB, id);
  if (!review) return apiError(c, 404, 'not_found', 'Review not found.');
  if (review.authorId !== user.id) {
    return apiError(c, 403, 'forbidden', 'You can only delete your own reviews.');
  }
  await deleteReview(c.env.DB, user.id, id);
  return c.json({ ok: true, id });
});

// --- polls -------------------------------------------------------------------

v1.get('/polls/:adaptationId', async (c) => {
  const adaptationId = toInt(c.req.param('adaptationId'));
  if (adaptationId === null || adaptationId < 1) {
    return validationError(c, 'adaptationId must be a positive integer.');
  }
  const adaptation = await getAdaptationSummary(c.env.DB, adaptationId);
  if (!adaptation) return apiError(c, 404, 'not_found', 'Adaptation not found.');
  const user = await v1User(c);
  const results = await getPollResults(c.env.DB, adaptationId);
  const userChoice = user ? await getUserChoice(c.env.DB, user.id, adaptationId) : null;
  return c.json({
    adaptation_id: adaptationId,
    counts: results.counts,
    total: results.total,
    user_choice: userChoice,
  });
});

v1.post('/polls/:adaptationId', async (c) => {
  const user = await v1User(c);
  if (!user) return unauthorized(c, 'Sign in to vote.');
  const adaptationId = toInt(c.req.param('adaptationId'));
  if (adaptationId === null || adaptationId < 1) {
    return validationError(c, 'adaptationId must be a positive integer.');
  }
  const body = await parseJsonBody(c);
  const choice = body['choice'] as PollChoice | undefined;
  if (!choice || !POLL_CHOICES.includes(choice)) {
    return validationError(
      c,
      "choice must be one of 'book', 'screen', 'both', 'undecided'.",
    );
  }
  const adaptation = await getAdaptationSummary(c.env.DB, adaptationId);
  if (!adaptation) return apiError(c, 404, 'not_found', 'Adaptation not found.');
  if (!(await checkPollsRate(c.env.DB, user.id))) {
    return apiError(
      c,
      429,
      'rate_limited',
      `Poll vote limit reached — ${MAX_POLLS_PER_HOUR} per hour.`,
    );
  }
  const results = await setPollVote(c.env.DB, user.id, adaptationId, choice);
  return c.json({
    adaptation_id: adaptationId,
    counts: results.counts,
    total: results.total,
    user_choice: choice,
  });
});

// --- hype --------------------------------------------------------------------

v1.get('/hype', async (c) => {
  const screenWorkId = toInt(c.req.query('screen_work_id'));
  if (screenWorkId === null || screenWorkId < 1) {
    return validationError(c, 'screen_work_id must be a positive integer.');
  }
  const work = await getScreenWork(c.env.DB, screenWorkId);
  if (!work) return apiError(c, 404, 'not_found', 'Screen work not found.');
  const user = await v1User(c);
  const summary = await getHypeSummary(c.env.DB, screenWorkId);
  const userLevel = user ? await getUserHype(c.env.DB, user.id, screenWorkId) : null;
  return c.json({
    screen_work_id: screenWorkId,
    average: summary.average,
    count: summary.count,
    user_level: userLevel,
  });
});

v1.post('/hype', async (c) => {
  const user = await v1User(c);
  if (!user) return unauthorized(c, 'Sign in to set your hype.');
  const body = await parseJsonBody(c);
  const screenWorkId = toInt(body['screen_work_id']);
  const level = toInt(body['level']);
  if (screenWorkId === null || screenWorkId < 1) {
    return validationError(c, 'screen_work_id must be a positive integer.');
  }
  if (level === null || level < 1 || level > 5) {
    return validationError(c, 'level must be an integer from 1 to 5.');
  }
  const work = await getScreenWork(c.env.DB, screenWorkId);
  if (!work) return apiError(c, 404, 'not_found', 'Screen work not found.');
  if (!(await checkHypeRate(c.env.DB, user.id))) {
    return apiError(
      c,
      429,
      'rate_limited',
      `Slow down — ${MAX_HYPE_PER_HOUR} hype changes per hour.`,
    );
  }
  const summary = await setHype(c.env.DB, user.id, screenWorkId, level);
  return c.json({
    screen_work_id: screenWorkId,
    average: summary.average,
    count: summary.count,
    user_level: level,
  });
});

// --- lists -------------------------------------------------------------------

const LIST_TITLE_MAX = 120;
const LIST_DESCRIPTION_MAX = 2000;
const LIST_NOTE_MAX = 500;

function cleanStr(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length > 0 && s.length <= max ? s : null;
}

v1.get('/lists', async (c) => {
  const user = await v1User(c);
  if (!user) return unauthorized(c, 'Sign in to manage lists.');
  const { page, per_page } = pagination(c, 50);
  const lists = await listUserLists(c.env.DB, user.id);
  return c.json(paginate(lists.map(listToJson), page, per_page));
});

// Public lists gallery — every public list, most recently updated first.
// No owner info is exposed (finding 1: emails never leave the API).
// Registered before /lists/:slug so "public" isn't treated as a slug.
v1.get('/lists/public', async (c) => {
  const { page, per_page, offset } = pagination(c, 20);
  const { lists, total } = await listPublicLists(c.env.DB, per_page, offset);
  return c.json({ data: lists.map(listToJson), page, per_page, total });
});

v1.post('/lists', async (c) => {
  const user = await v1User(c);
  if (!user) return unauthorized(c, 'Sign in to manage lists.');
  const body = await parseJsonBody(c);
  const title = cleanStr(body['title'], LIST_TITLE_MAX);
  if (!title) {
    return validationError(
      c,
      `title must be a non-empty string of at most ${LIST_TITLE_MAX} characters.`,
    );
  }
  let description: string | null = null;
  if (body['description'] !== undefined && body['description'] !== null) {
    description = cleanStr(body['description'], LIST_DESCRIPTION_MAX);
    if (description === null && str(body['description']) !== '') {
      return validationError(
        c,
        `description must be at most ${LIST_DESCRIPTION_MAX} characters.`,
      );
    }
  }
  const isPublic = body['is_public'] === undefined ? true : body['is_public'] !== false;
  if (!(await checkListRate(c.env.DB, user.id))) {
    return apiError(
      c,
      429,
      'rate_limited',
      `List limit reached — ${MAX_LISTS_PER_HOUR} lists per hour.`,
    );
  }
  const { id, slug } = await createList(c.env.DB, user.id, {
    title,
    description,
    isPublic,
  });
  return c.json({ id, slug }, 201);
});

v1.get('/lists/:slug', async (c) => {
  const slug = c.req.param('slug');
  const list = await getListBySlug(c.env.DB, slug);
  const user = await v1User(c);
  const isOwner = !!user && !!list && list.user_id === user.id;
  // Private lists 404 for non-owners — never leak that a list exists.
  if (!list || (list.is_public !== 1 && !isOwner)) {
    return apiError(c, 404, 'not_found', 'List not found.');
  }
  const items = await listListItems(c.env.DB, list.id);
  const counts = await listUserLists(c.env.DB, list.user_id);
  const summary = counts.find((l) => l.id === list.id);
  return c.json({
    list: listToJson({
      ...list,
      itemCount: summary?.itemCount ?? items.length,
    }),
    items: items.map(listItemToJson),
    is_owner: isOwner,
  });
});

v1.put('/lists/:id', async (c) => {
  const user = await v1User(c);
  if (!user) return unauthorized(c, 'Sign in to manage lists.');
  const id = toInt(c.req.param('id'));
  if (id === null || id < 1) return validationError(c, 'List id must be a positive integer.');
  const body = await parseJsonBody(c);
  const input: { title?: string; description?: string | null; isPublic?: boolean } = {};
  if (body['title'] !== undefined) {
    const title = cleanStr(body['title'], LIST_TITLE_MAX);
    if (!title) {
      return validationError(
        c,
        `title must be a non-empty string of at most ${LIST_TITLE_MAX} characters.`,
      );
    }
    input.title = title;
  }
  if (body['description'] !== undefined) {
    if (body['description'] === null || str(body['description']) === '') {
      input.description = null;
    } else {
      const d = cleanStr(body['description'], LIST_DESCRIPTION_MAX);
      if (!d) {
        return validationError(
          c,
          `description must be at most ${LIST_DESCRIPTION_MAX} characters.`,
        );
      }
      input.description = d;
    }
  }
  if (body['is_public'] !== undefined) input.isPublic = body['is_public'] !== false;
  const result = await updateList(c.env.DB, user.id, id, input);
  if (result === 'not_found') return apiError(c, 404, 'not_found', 'List not found.');
  if (result === 'forbidden') {
    return apiError(c, 403, 'forbidden', 'You do not own this list.');
  }
  // Title/description/visibility changed — drop the cached bot preview so a
  // privatized list stops serving its old public preview from the edge.
  const updated = await getListById(c.env.DB, id);
  if (updated) {
    c.executionCtx.waitUntil(
      purgeListPreview(new URL(c.req.url).origin, updated.slug),
    );
  }
  return c.json({ ok: true });
});

v1.delete('/lists/:id', async (c) => {
  const user = await v1User(c);
  if (!user) return unauthorized(c, 'Sign in to manage lists.');
  const id = toInt(c.req.param('id'));
  if (id === null || id < 1) return validationError(c, 'List id must be a positive integer.');
  const doomed = await getListById(c.env.DB, id);
  const result = await deleteList(c.env.DB, user.id, id);
  if (result === 'not_found') return apiError(c, 404, 'not_found', 'List not found.');
  if (result === 'forbidden') {
    return apiError(c, 403, 'forbidden', 'You do not own this list.');
  }
  // Deleted — drop the cached bot preview so the old public page stops
  // serving from the edge.
  if (doomed) {
    c.executionCtx.waitUntil(
      purgeListPreview(new URL(c.req.url).origin, doomed.slug),
    );
  }
  return c.json({ ok: true });
});

v1.post('/lists/:id/items', async (c) => {
  const user = await v1User(c);
  if (!user) return unauthorized(c, 'Sign in to manage lists.');
  const id = toInt(c.req.param('id'));
  if (id === null || id < 1) return validationError(c, 'List id must be a positive integer.');
  const body = await parseJsonBody(c);
  const targetType = body['target_type'] as ListTargetType | undefined;
  const targetId = toInt(body['target_id']);
  if (!targetType || !LIST_TARGET_TYPES.includes(targetType)) {
    return validationError(c, "target_type must be 'book' or 'screen_work'.");
  }
  if (targetId === null || targetId < 1) {
    return validationError(c, 'target_id must be a positive integer.');
  }
  let note: string | null = null;
  if (body['note'] !== undefined && body['note'] !== null) {
    if (typeof body['note'] !== 'string') {
      return validationError(c, 'note must be a string.');
    }
    const trimmed = body['note'].trim();
    if (trimmed.length > LIST_NOTE_MAX) {
      return validationError(c, `note must be at most ${LIST_NOTE_MAX} characters.`);
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
    const [status, message] = errorMap[result.status];
    const code = status === 409 ? 'conflict' : status === 403 ? 'forbidden' : 'not_found';
    return apiError(c, status, code, message);
  }
  return c.json({ id: result.id }, 201);
});

v1.delete('/lists/:id/items/:itemId', async (c) => {
  const user = await v1User(c);
  if (!user) return unauthorized(c, 'Sign in to manage lists.');
  const id = toInt(c.req.param('id'));
  const itemId = toInt(c.req.param('itemId'));
  if (id === null || id < 1) return validationError(c, 'List id must be a positive integer.');
  if (itemId === null || itemId < 1) {
    return validationError(c, 'Item id must be a positive integer.');
  }
  const result = await removeItem(c.env.DB, user.id, id, itemId);
  if (result === 'not_found') return apiError(c, 404, 'not_found', 'List not found.');
  if (result === 'forbidden') {
    return apiError(c, 403, 'forbidden', 'You do not own this list.');
  }
  if (result === 'item_not_found') {
    return apiError(c, 404, 'not_found', 'Item not found on this list.');
  }
  return c.json({ ok: true });
});

v1.put('/lists/:id/items', async (c) => {
  const user = await v1User(c);
  if (!user) return unauthorized(c, 'Sign in to manage lists.');
  const id = toInt(c.req.param('id'));
  if (id === null || id < 1) return validationError(c, 'List id must be a positive integer.');
  const body = await parseJsonBody(c);
  const order = body['order'];
  if (
    !Array.isArray(order) ||
    order.some((x) => !Number.isInteger(x) || (x as number) < 1)
  ) {
    return validationError(c, 'order must be an array of positive integer item ids.');
  }
  // Ownership check first (404/403 take precedence over a bad order body).
  const list = await getListById(c.env.DB, id);
  if (!list) return apiError(c, 404, 'not_found', 'List not found.');
  if (list.user_id !== user.id) {
    return apiError(c, 403, 'forbidden', 'You do not own this list.');
  }
  const result = await reorderItems(c.env.DB, user.id, id, order as number[]);
  if (result === 'bad_ids') {
    return validationError(c, 'order contains unknown or duplicate item ids.');
  }
  return c.json({ ok: true });
});

// --- shelves -----------------------------------------------------------------

v1.get('/shelves', async (c) => {
  const user = await v1User(c);
  if (!user) return unauthorized(c, 'Sign in to view your shelves.');
  const shelves = await listShelves(c.env.DB, user.id);
  return c.json({
    shelves: shelves.map((s) => ({
      target_type: s.targetType,
      target_id: s.targetId,
      title: s.title,
      slug: s.slug,
      shelf: s.shelf,
    })),
  });
});

v1.post('/shelves', async (c) => {
  const user = await v1User(c);
  if (!user) return unauthorized(c, 'Sign in to manage shelves.');
  const body = await parseJsonBody(c);
  const targetType = body['target_type'] as ShelfTargetType | undefined;
  const targetId = toInt(body['target_id']);
  const shelf = body['shelf'] as ShelfName | undefined;
  if (!targetType || !SHELF_TARGET_TYPES.includes(targetType)) {
    return validationError(c, "target_type must be 'book' or 'adaptation'.");
  }
  if (!shelf || !SHELVES.includes(shelf)) {
    return validationError(
      c,
      "shelf must be 'want_to_read', 'read', 'want_to_watch', or 'watched'.",
    );
  }
  if (targetId === null || targetId < 1) {
    return validationError(c, 'target_id must be a positive integer.');
  }
  const exists =
    targetType === 'book'
      ? (await getBook(c.env.DB, targetId)) !== null
      : (await getAdaptationSummary(c.env.DB, targetId)) !== null;
  if (!exists) return apiError(c, 404, 'not_found', 'Target not found.');
  await upsertShelf(c.env.DB, user.id, targetType, targetId, shelf);
  return c.json({ ok: true });
});

v1.delete('/shelves', async (c) => {
  const user = await v1User(c);
  if (!user) return unauthorized(c, 'Sign in to manage shelves.');
  const body = await parseJsonBody(c);
  const targetType = body['target_type'] as ShelfTargetType | undefined;
  const targetId = toInt(body['target_id']);
  if (!targetType || !SHELF_TARGET_TYPES.includes(targetType)) {
    return validationError(c, "target_type must be 'book' or 'adaptation'.");
  }
  if (targetId === null || targetId < 1) {
    return validationError(c, 'target_id must be a positive integer.');
  }
  await removeShelf(c.env.DB, user.id, targetType, targetId);
  return c.json({ ok: true });
});

// --- search ------------------------------------------------------------------

const SEARCH_QUERY_MAX = 100;

v1.get('/search', async (c) => {
  const q = str(c.req.query('q')).slice(0, SEARCH_QUERY_MAX);
  const rawLimit = Number(c.req.query('limit'));
  // Search helpers cap each group at RESULT_LIMIT (12); `limit` can only
  // narrow that, never widen it — no SQL is duplicated here.
  let limit = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : RESULT_LIMIT;
  limit = Math.min(limit, RESULT_LIMIT);
  // Kind/status filters apply in SQL so the capped groups aren't wasted on
  // rows the client would discard. `status=upcoming` = pre-release pipeline.
  const f = parseKindStatusFilter(c);
  if (!f.ok) return f.response;
  if (!q) {
    // Pure public fallback (no user fields) — safe to edge-cache.
    return edgeCached(c, async () =>
      c.json({
        q: '',
        books: { data: [], total: 0 },
        screen_works: { data: [], total: 0 },
        adaptations: { data: [], total: 0 },
        popular: await getPopularBooks(c.env.DB),
      }),
    );
  }
  return edgeCached(c, async () => {
    // One D1 round trip for the three search groups (was: three).
    const searchBatch = await c.env.DB.batch(
      searchStatements(c.env.DB, q, { kind: f.kind, statuses: f.statuses }),
    );
    const booksRes = batched(searchBatch, 0);
    const worksRes = batched(searchBatch, 1);
    const storiesRes = batched(searchBatch, 2);
    const books = (booksRes.results ?? []) as BookHit[];
    const works = (worksRes.results ?? []) as ScreenWorkHit[];
    const stories = (storiesRes.results ?? []) as AdaptationHit[];
    const group = <T,>(rows: T[]) => {
      const data = rows.slice(0, limit);
      return { data, total: data.length };
    };
    const popular =
      books.length + works.length + stories.length === 0
        ? await getPopularBooks(c.env.DB)
        : [];
    // Pure function of (q, kind, status) — no user fields — safe to edge-cache per URL.
    return c.json({
      q,
      books: group(books),
      screen_works: group(works),
      adaptations: group(stories),
      popular,
    });
  });
});

// --- calendar ----------------------------------------------------------------

v1.get('/calendar', async (c) => {
  // Single query, identical for every visitor — safe to edge-cache.
  // Earlier releases are year-summarized; only the newest year's items ship
  // inline (it renders open on first paint). Older years lazy-load via
  // /calendar/year/:year when their <details> opens, so the payload stays
  // ~tens of KB no matter how large the catalog grows.
  return edgeCached(c, async () => {
    const { today, buckets, earlierYears } = await getCalendarFeed(c.env.DB);
    const newestYear = earlierYears[0]?.year ?? '';
    return c.json({
      today,
      coming_soon: buckets.comingSoon,
      recently_released: buckets.recentlyReleased,
      earlier_years: earlierYears,
      earlier_releases: buckets.earlierReleases.filter(
        (w) => (w.release_date ?? '').slice(0, 4) === newestYear,
      ),
      tba: buckets.tba,
    });
  });
});

// One earlier-release year, for lazy-loading a collapsed calendar year group.
v1.get('/calendar/year/:year', async (c) => {
  const year = c.req.param('year');
  if (!/^\d{4}$/.test(year)) return c.json({ error: 'invalid year' }, 400);
  return edgeCached(c, async () => {
    const today = new Date().toISOString().slice(0, 10);
    const works = await getEarlierWorksForYear(
      c.env.DB,
      year,
      recentWindowStart(today),
    );
    return c.json({ year, works });
  });
});

// Site-wide recent news for the home page strip: approved items only,
// newest first. Edge-cached like the calendar — identical for every visitor.
v1.get('/news/recent', async (c) => {
  return edgeCached(c, async () => {
    const rawLimit = Number(c.req.query('limit'));
    const limit =
      Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 20) : 8;
    const { results } = await c.env.DB
      .prepare(
        `SELECT * FROM news_items
           WHERE status = 'approved'
           ORDER BY published_at DESC NULLS LAST, id DESC
           LIMIT ?1`,
      )
      .bind(limit)
      .all<NewsItem>();
    return c.json({ items: (results ?? []).map(newsToJson) });
  });
});

// --- feedback (public submit) -------------------------------------------------

const URL_RE = /^https?:\/\/\S+$/i;
const FEEDBACK_SUBJECT_MIN = 3;
const FEEDBACK_SUBJECT_MAX = 120;
const FEEDBACK_BODY_MIN = 10;
const FEEDBACK_BODY_MAX = 5000;

function isFeedbackType(v: unknown): v is FeedbackType {
  return typeof v === 'string' && (FEEDBACK_TYPES as string[]).includes(v);
}

v1.post('/feedback', async (c) => {
  const body = await parseJsonBody(c);
  const type = str(body['type']);
  const subject = str(body['subject']);
  const text = str(body['body']);
  const proofUrl = str(body['proof_url']);
  const email = str(body['email']);

  if (!isFeedbackType(type)) {
    return validationError(c, `type must be one of: ${FEEDBACK_TYPES.join(', ')}.`);
  }
  if (subject.length < FEEDBACK_SUBJECT_MIN || subject.length > FEEDBACK_SUBJECT_MAX) {
    return validationError(
      c,
      `subject must be ${FEEDBACK_SUBJECT_MIN}–${FEEDBACK_SUBJECT_MAX} characters (yours is ${subject.length}).`,
    );
  }
  if (text.length < FEEDBACK_BODY_MIN || text.length > FEEDBACK_BODY_MAX) {
    return validationError(
      c,
      `body must be ${FEEDBACK_BODY_MIN}–${FEEDBACK_BODY_MAX} characters (yours is ${text.length}).`,
    );
  }
  if (proofUrl && !URL_RE.test(proofUrl)) {
    return validationError(c, 'proof_url must start with http:// or https://.');
  }
  if (email && !EMAIL_RE.test(email)) {
    return validationError(c, 'That email address doesn’t look valid.');
  }
  if (!(await checkFeedbackRate(c.env.DB, clientIp(c.req.raw.headers)))) {
    return apiError(c, 429, 'rate_limited', 'Too many submissions — try again in an hour.');
  }
  const sessionUser = await getUser(c);
  const id = await createFeedback(c.env.DB, {
    userId: sessionUser ? sessionUser.id : null,
    email: email || null,
    type,
    subject,
    body: text,
    proofUrl: proofUrl || null,
  });
  return c.json({ ok: true, id }, 201);
});

// --- theme -------------------------------------------------------------------

v1.post('/theme', async (c) => {
  const body = await parseJsonBody(c);
  const theme = body['theme'];
  if (theme !== 'light' && theme !== 'dark') {
    return validationError(c, "theme must be 'light' or 'dark'.");
  }
  setThemeCookie(c, theme);
  return c.json({ ok: true, theme });
});

// --- admin -------------------------------------------------------------------

v1.use('/admin/*', async (c, next) => {
  const user: SessionUser | null = await getUser(c);
  if (!user) {
    return apiError(c, 401, 'unauthorized', 'Sign in to continue.');
  }
  if (!user.isAdmin) {
    return apiError(c, 403, 'forbidden', 'Admin access required.');
  }
  await next();
});

const VALID_QUEUE_STATUSES: NewsStatus[] = ['pending', 'approved', 'dismissed'];

v1.get('/admin/news', async (c) => {
  const raw = c.req.query('status') ?? 'pending';
  const status: NewsStatus = (VALID_QUEUE_STATUSES as string[]).includes(raw)
    ? (raw as NewsStatus)
    : 'pending';
  const { page, per_page } = pagination(c, 50);
  const [items, counts] = await Promise.all([
    listNewsItems(c.env.DB, status),
    countNewsByStatus(c.env.DB),
  ]);
  return c.json({
    status,
    items: paginate(items.map(newsToJson), page, per_page),
    counts,
  });
});

v1.post('/admin/news/:id/approve', async (c) => {
  const id = toInt(c.req.param('id'));
  if (id === null || id < 1) {
    return validationError(c, 'News item id must be a positive integer.');
  }
  const item = await getNewsItem(c.env.DB, id);
  if (!item) return apiError(c, 404, 'not_found', `News item ${id} not found.`);
  await setNewsItemStatus(c.env.DB, item.id, 'approved');
  return c.json({ ok: true, id: item.id, status: 'approved' });
});

v1.post('/admin/news/:id/dismiss', async (c) => {
  const id = toInt(c.req.param('id'));
  if (id === null || id < 1) {
    return validationError(c, 'News item id must be a positive integer.');
  }
  const item = await getNewsItem(c.env.DB, id);
  if (!item) return apiError(c, 404, 'not_found', `News item ${id} not found.`);
  const body = await parseJsonBody(c);
  const reason =
    typeof body['reason'] === 'string' ? body['reason'].slice(0, 500) : undefined;
  await setNewsItemStatus(c.env.DB, item.id, 'dismissed', reason);
  return c.json({ ok: true, id: item.id, status: 'dismissed' });
});

v1.post('/admin/news/:id/promote', async (c) => {
  const id = toInt(c.req.param('id'));
  if (id === null || id < 1) {
    return validationError(c, 'News item id must be a positive integer.');
  }
  const item = await getNewsItem(c.env.DB, id);
  if (!item) return apiError(c, 404, 'not_found', `News item ${id} not found.`);
  const body = await parseJsonBody(c);

  const adaptationId = toInt(body['adaptation_id']);
  if (adaptationId === null || adaptationId < 1) {
    return validationError(c, 'adaptation_id (integer) is required.');
  }
  const adaptation = await getAdaptationSummary(c.env.DB, adaptationId);
  if (!adaptation) {
    return apiError(c, 404, 'not_found', `Adaptation ${adaptationId} not found.`);
  }

  // Rumor-tier items need a manually attached corroborating source.
  const corroboratingUrl =
    typeof body['corroborating_url'] === 'string' && body['corroborating_url'].trim()
      ? body['corroborating_url'].trim().slice(0, 2000)
      : null;
  if (item.trust_tier === 'rumor' && !corroboratingUrl) {
    return validationError(
      c,
      'corroborating_url is required to promote a rumor-tier item.',
    );
  }

  let newStatus: string;
  if (body['status'] !== undefined) {
    if (
      typeof body['status'] !== 'string' ||
      !(ADAPTATION_STATUSES as readonly string[]).includes(body['status'])
    ) {
      return validationError(
        c,
        `status must be one of: ${ADAPTATION_STATUSES.join(', ')}.`,
      );
    }
    newStatus = body['status'];
  } else {
    const next = nextStatusAfter(adaptation.status);
    if (!next) {
      return validationError(
        c,
        `Adaptation is already '${adaptation.status}' — no next step; pass an explicit status.`,
      );
    }
    newStatus = next;
  }

  const sourceUrl = corroboratingUrl ?? item.url;
  const { oldStatus } = await promoteNewsItem(
    c.env.DB,
    item,
    adaptationId,
    newStatus,
    sourceUrl,
    'owner',
  );
  // Queue the linked screen work for TMDB poster enrichment when poster-less.
  await flagEnrichmentForAdaptation(c.env.DB, adaptationId);

  return c.json({
    ok: true,
    news_item_id: item.id,
    adaptation_id: adaptationId,
    old_status: oldStatus,
    new_status: newStatus,
    source_url: sourceUrl,
  });
});

v1.get('/admin/news/runs', async (c) => {
  const { page, per_page } = pagination(c, 50);
  const runs = await listPipelineRuns(c.env.DB, 200);
  return c.json({ runs: paginate(runs, page, per_page) });
});

v1.post('/admin/backfill/tmdb', async (c) => {
  const parsed = parseBatchSize(c.req.query('n'));
  if (!parsed.ok) return validationError(c, parsed.error);
  try {
    const batch = await runEnrichmentBatch(
      { DB: c.env.DB, TMDB_API_KEY: c.env.TMDB_API_KEY },
      parsed.n,
    );
    const remaining = await countRemaining(c.env.DB);
    return c.json({ ...batch, remaining });
  } catch (e) {
    console.error('/api/v1/admin/backfill/tmdb failed:', (e as Error).message);
    return apiError(c, 500, 'internal_error', 'Enrichment batch failed.');
  }
});

// Full backfill: TMDB search (poster/backdrop/release date/synopsis) plus
// watch-provider cache refresh, in small chunks for the catalog build-out.
// POST /admin/backfill/tmdb-full?n=10 → { done, enriched, failed,
// providers_cached, remaining }. Same admin gate as the routes above.
v1.post('/admin/backfill/tmdb-full', async (c) => {
  const parsed = parseBatchSize(c.req.query('n'));
  if (!parsed.ok) return validationError(c, parsed.error);
  try {
    const batch = await runFullBatch(
      { DB: c.env.DB, TMDB_API_KEY: c.env.TMDB_API_KEY },
      parsed.n,
    );
    const remaining = await countRemainingFull(c.env.DB);
    return c.json({ ...batch, remaining });
  } catch (e) {
    console.error(
      '/api/v1/admin/backfill/tmdb-full failed:',
      (e as Error).message,
    );
    return apiError(c, 500, 'internal_error', 'Full backfill batch failed.');
  }
});

v1.get('/admin/screen-works', async (c) => {
  const { page, per_page } = pagination(c, 100);
  const works = await listScreenWorksForAdmin(c.env.DB);
  return c.json({ screen_works: paginate(works, page, per_page) });
});

v1.post('/admin/screen-works/:id/release-date', async (c) => {
  const id = toInt(c.req.param('id'));
  if (id === null || id < 1) {
    return validationError(c, 'Screen work id must be a positive integer.');
  }
  const body = await parseJsonBody(c);
  const parsed = validateReleaseDate(body['release_date']);
  if (!parsed.ok) return validationError(c, parsed.error);
  const existing = await c.env.DB
    .prepare('SELECT id FROM screen_works WHERE id = ?1')
    .bind(id)
    .first<{ id: number }>();
  if (!existing) {
    return apiError(c, 404, 'not_found', `Screen work ${id} not found.`);
  }
  // Clearing the date or moving it to the future would invalidate linked
  // 'released' adaptations — reject so the admin updates those first.
  const violated = await releasedAdaptationsViolatedByDate(c.env.DB, id, parsed.value);
  if (violated.length > 0) {
    return validationError(
      c,
      `Cannot set release_date: adaptation${violated.length === 1 ? '' : 's'} ${violated.join(', ')} ${violated.length === 1 ? 'is' : 'are'} 'released' — change ${violated.length === 1 ? 'its' : 'their'} status first.`,
    );
  }
  await c.env.DB
    .prepare('UPDATE screen_works SET release_date = ?1 WHERE id = ?2')
    .bind(parsed.value, id)
    .run();
  return c.json({ ok: true, id, release_date: parsed.value });
});

function isTriageStatus(v: unknown): v is Extract<FeedbackStatus, 'reviewed' | 'done'> {
  return v === 'reviewed' || v === 'done';
}

v1.get('/admin/feedback', async (c) => {
  const rawType = c.req.query('type');
  const rawStatus = c.req.query('status');
  const type = isFeedbackType(rawType) ? rawType : undefined;
  const status: FeedbackStatus | undefined = (FEEDBACK_STATUSES as string[]).includes(
    rawStatus ?? '',
  )
    ? (rawStatus as FeedbackStatus)
    : undefined;
  const { page, per_page } = pagination(c, 50);
  const [items, counts] = await Promise.all([
    listFeedback(c.env.DB, { type, status }),
    countFeedbackByStatus(c.env.DB),
  ]);
  return c.json({
    filters: { type: type ?? null, status: status ?? null },
    feedback: paginate(items, page, per_page),
    counts,
  });
});

v1.post('/admin/feedback/:id/status', async (c) => {
  const id = toInt(c.req.param('id'));
  if (id === null || id < 1) {
    return validationError(c, 'Feedback id must be a positive integer.');
  }
  const body = await parseJsonBody(c);
  if (!isTriageStatus(body['status'])) {
    return validationError(c, "status must be 'reviewed' or 'done'.");
  }
  const item = await getFeedback(c.env.DB, id);
  if (!item) return apiError(c, 404, 'not_found', `Feedback ${id} not found.`);
  await setFeedbackStatus(c.env.DB, id, body['status']);
  return c.json({ ok: true, id, status: body['status'] });
});

// Fetch book/screen metadata for an adaptation tip and create the catalog
// records (book, screen work, adaptation) atomically, then mark the tip
// done. Admin-only via the /admin/* gate above.
v1.post('/admin/feedback/:id/intake', async (c) => {
  const id = toInt(c.req.param('id'));
  if (id === null || id < 1) {
    return validationError(c, 'Feedback id must be a positive integer.');
  }
  const item = await getFeedback(c.env.DB, id);
  if (!item) return apiError(c, 404, 'not_found', `Feedback ${id} not found.`);
  if (item.type !== 'adaptation_tip') {
    return validationError(c, 'Metadata intake is only for adaptation tips.');
  }
  if (item.status === 'done') {
    return validationError(c, 'This tip is already marked done.');
  }
  try {
    const result = await intakeFromTip(c.env.DB, {
      subject: item.subject,
      proofUrl: item.proof_url,
      sourceUrl: item.proof_url,
      tmdbApiKey: c.env.TMDB_API_KEY,
    });
    // Warm the where-to-watch cache in the background; the page works
    // without it.
    const tmdbIdRow = await c.env.DB.prepare(
      'SELECT tmdb_id FROM screen_works WHERE id = ?1',
    )
      .bind(result.screenWork.id)
      .first<{ tmdb_id: number | null }>();
    if (c.env.TMDB_API_KEY && tmdbIdRow?.tmdb_id) {
      c.executionCtx.waitUntil(
        fetchAndCacheProviders(
          c.env.DB,
          c.env.TMDB_API_KEY,
          result.screenWork.id,
          tmdbIdRow.tmdb_id,
          result.screenWork.kind as 'film' | 'series',
        ).catch((e) => console.error('intake provider warm failed:', (e as Error).message)),
      );
    }
    await setFeedbackStatus(c.env.DB, id, 'done');
    // Tell IndexNow about the new/changed catalog pages — fire-and-forget;
    // indexing must never fail the intake response.
    c.executionCtx.waitUntil(
      (async () => {
        const origin = new URL(c.req.url).origin;
        const slugs = await c.env.DB.batch([
          c.env.DB.prepare('SELECT slug, id FROM books WHERE id = ?1').bind(result.book.id),
          c.env.DB.prepare('SELECT slug, id FROM screen_works WHERE id = ?1').bind(result.screenWork.id),
          c.env.DB.prepare('SELECT slug, id FROM adaptations WHERE id = ?1').bind(result.adaptation.id),
        ]);
        const pick = (i: number, base: string): string | null => {
          const row = slugs[i]?.results?.[0] as { slug: string | null; id: number } | undefined;
          return row ? `${origin}${base}/${row.slug ?? row.id}` : null;
        };
        const urls = [
          pick(0, '/books'),
          pick(1, '/watch'),
          pick(2, '/adaptations'),
        ].filter((u): u is string => u !== null);
        await submitIndexNow(c.env, origin, urls);
      })().catch((e) => console.error('indexnow intake hook failed:', (e as Error).message)),
    );
    return c.json({ ok: true, id, ...result });
  } catch (e) {
    if (e instanceof IntakeError) {
      return apiError(c, 422, 'intake_failed', e.message);
    }
    console.error(`/api/v1/admin/feedback/${id}/intake failed:`, (e as Error).message);
    return apiError(c, 500, 'intake_failed', 'Metadata intake failed.');
  }
});

// --- unknown routes ----------------------------------------------------------
// NOTE: a trailing wildcard (not v1.notFound) is used on purpose — Hono
// merges sub-app routes into the parent on app.route(), so the parent's
// notFound (the HTML 404 page) would otherwise win for unknown /api/v1/*
// paths. This route is registered last, so every real route wins first.
v1.all('/*', (c) => apiError(c, 404, 'not_found', 'Unknown API endpoint.'));

/** Mount the versioned API at /api/v1 on the app. */
export function mountV1(app: Hono<{ Bindings: Env }>): void {
  app.route('/api/v1', v1);
}
