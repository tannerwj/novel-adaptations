/**
 * src/news/curation.ts — owner-only curation queue routes (Phase 3).
 *
 * Mounted by src/index.tsx:
 *   GET  /admin/news?status=pending    — server-rendered curation queue
 *   POST /api/news/:id/approve        — status → approved
 *   POST /api/news/:id/dismiss        — status → dismissed (+ optional reason)
 *   POST /api/news/:id/promote        — approve + advance a linked adaptation
 *
 * AUTH: every route is gated behind admin sessions. /admin/* uses
 * requireAdminPage (logged-out → 303 to /auth/login; non-admin → 403) and
 * /api/news/* uses requireAdminApi (→ 403 JSON). Fail closed: without a
 * valid admin session, ALL requests are denied. Admin status is granted
 * solely via the ADMIN_EMAILS bootstrap in GET /auth/verify
 * (see migration 0007_admin_roles.sql) — no route here mutates is_admin.
 */

import type { Context, Hono } from 'hono';
import { requireAdminApi, requireAdminPage } from '../auth/session';
import {
  ADAPTATION_STATUSES,
  countNewsByStatus,
  getAdaptationSummary,
  getNewsItem,
  listNewsItems,
  listSources,
  nextStatusAfter,
  promoteNewsItem,
  setNewsItemStatus,
  type NewsItem,
  type NewsStatus,
} from '../db';
import { listPipelineRuns } from './ingest';
// PipelineRunsPage is provided by the UI track in src/ui.tsx with props
// { runs: PipelineRun[], sources: SourceRow[] }.
import { NewsQueuePage, PipelineRunsPage } from '../ui';

type CurationBindings = {
  DB: D1Database;
};

const VALID_QUEUE_STATUSES: NewsStatus[] = ['pending', 'approved', 'dismissed'];

async function parseJsonBody(c: Context): Promise<Record<string, unknown>> {
  try {
    const b = await c.req.json();
    return typeof b === 'object' && b !== null ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function registerCurationRoutes<E extends CurationBindings>(
  app: Hono<{ Bindings: E }>,
): void {
  // Admin-only: page routes redirect logged-out users to sign-in,
  // API routes answer 403 JSON. Both fail closed.
  app.use('/admin/*', requireAdminPage);
  app.use('/api/news/*', requireAdminApi);

  app.get('/admin/news', async (c) => {
    const raw = c.req.query('status') ?? 'pending';
    const status: NewsStatus = (
      VALID_QUEUE_STATUSES as string[]
    ).includes(raw)
      ? (raw as NewsStatus)
      : 'pending';
    const [items, sources, counts] = await Promise.all([
      listNewsItems(c.env.DB, status),
      listSources(c.env.DB),
      countNewsByStatus(c.env.DB),
    ]);
    // Caution guardrail: needs_review=1 items sort to the top of the pending
    // queue so the owner sees uncertain classifications first. (Ordering is
    // done here, not in src/db.ts's listNewsItems, which Track A doesn't own.)
    const ordered =
      status === 'pending'
        ? [...items].sort((a, b) => (b.needs_review ?? 0) - (a.needs_review ?? 0))
        : items;
    return c.html(
      <>
        <nav class="tabs" aria-label="admin">
          <a href="/admin/news/runs">Pipeline runs</a>
        </nav>
        <NewsQueuePage
          status={status}
          items={ordered}
          sources={sources}
          counts={counts}
        />
      </>,
    );
  });

  // Owner-visible observability for the autonomous pipeline: every scheduled
  // run (ran/disabled/error) with its counters. Same admin-session gate as
  // the queue (app.use('/admin/*', requireAdminPage) above).
  app.get('/admin/news/runs', async (c) => {
    const [runs, sources] = await Promise.all([
      listPipelineRuns(c.env.DB, 50),
      listSources(c.env.DB),
    ]);
    // PipelineRun rows are snake_case (DB convention); PipelineRunsPage takes
    // the camelCase view-model from src/ui.tsx.
    return c.html(
      <PipelineRunsPage
        runs={runs.map((r) => ({
          id: r.id,
          startedAt: r.started_at,
          finishedAt: r.finished_at,
          status: r.status,
          feedsOk: r.feeds_ok,
          feedsFailed: r.feeds_failed,
          itemsFetched: r.items_fetched,
          itemsNew: r.items_new,
          itemsSkippedCap: r.items_skipped_cap,
          llmCalls: r.llm_calls,
          errors: r.errors,
        }))}
        sources={sources}
      />,
    );
  });

  app.post('/api/news/:id/approve', async (c) => {
    const item = await requireItem(c);
    if (item instanceof Response) return item;
    await setNewsItemStatus(c.env.DB, item.id, 'approved');
    return c.json({ ok: true, id: item.id, status: 'approved' });
  });

  app.post('/api/news/:id/dismiss', async (c) => {
    const item = await requireItem(c);
    if (item instanceof Response) return item;
    const body = await parseJsonBody(c);
    const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : undefined;
    await setNewsItemStatus(c.env.DB, item.id, 'dismissed', reason);
    return c.json({ ok: true, id: item.id, status: 'dismissed' });
  });

  app.post('/api/news/:id/promote', async (c) => {
    const item = await requireItem(c);
    if (item instanceof Response) return item;
    const body = await parseJsonBody(c);

    const adaptationId = Number(body.adaptation_id);
    if (!Number.isInteger(adaptationId) || adaptationId <= 0) {
      return c.json({ error: 'adaptation_id (integer) is required' }, 400);
    }
    const adaptation = await getAdaptationSummary(c.env.DB, adaptationId);
    if (!adaptation) {
      return c.json({ error: `adaptation ${adaptationId} not found` }, 404);
    }

    // Rumor-tier items need a manually attached corroborating source.
    // Reputable/trusted promotions need no corroboration (owner default).
    const corroboratingUrl =
      typeof body.corroborating_url === 'string' && body.corroborating_url.trim()
        ? body.corroborating_url.trim().slice(0, 2000)
        : null;
    if (item.trust_tier === 'rumor' && !corroboratingUrl) {
      return c.json(
        { error: 'corroborating_url is required to promote a rumor-tier item' },
        400,
      );
    }

    let newStatus: string;
    if (body.status !== undefined) {
      if (
        typeof body.status !== 'string' ||
        !(ADAPTATION_STATUSES as readonly string[]).includes(body.status)
      ) {
        return c.json(
          { error: `invalid status; must be one of: ${ADAPTATION_STATUSES.join(', ')}` },
          400,
        );
      }
      newStatus = body.status;
    } else {
      const next = nextStatusAfter(adaptation.status);
      if (!next) {
        return c.json(
          {
            error: `adaptation is already '${adaptation.status}' — no next step; pass an explicit status`,
          },
          400,
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
    return c.json({
      ok: true,
      news_item_id: item.id,
      adaptation_id: adaptationId,
      old_status: oldStatus,
      new_status: newStatus,
      source_url: sourceUrl,
    });
  });
}

async function requireItem<E extends CurationBindings>(
  c: Context<{ Bindings: E }>,
): Promise<NewsItem | Response> {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: 'invalid news item id' }, 400);
  }
  const item = await getNewsItem(c.env.DB, id);
  if (!item) return c.json({ error: `news item ${id} not found` }, 404);
  return item;
}
