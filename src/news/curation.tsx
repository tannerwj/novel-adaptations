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
import { getUser, requireAdminApi, requireAdminPage } from '../auth/session';
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
// Layout for the release-dates admin page (Track 1, Round 3); screen works
// have no other edit surface, so curation.tsx owns this admin table too.
import { Layout, themeOf, type AuthUser, type ThemeName } from '../ui';

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
  // Release-date writes are owner-only JSON API, same fail-closed gate.
  app.use('/api/screen-works/*', requireAdminApi);

  app.get('/admin/news', async (c) => {
    const raw = c.req.query('status') ?? 'pending';
    const status: NewsStatus = (
      VALID_QUEUE_STATUSES as string[]
    ).includes(raw)
      ? (raw as NewsStatus)
      : 'pending';
    const [items, sources, counts, swCounts] = await Promise.all([
      listNewsItems(c.env.DB, status),
      listSources(c.env.DB),
      countNewsByStatus(c.env.DB),
      // Round 3 / Track 5: enrichment observability — poster-less vs total
      // screen works (migration 0013 needs_enrichment flag drives the queue).
      c.env.DB
        .prepare(
          `SELECT COUNT(*) AS total,
                  SUM(CASE WHEN poster_url IS NULL OR poster_url = '' THEN 1 ELSE 0 END) AS posterless
             FROM screen_works`,
        )
        .first<{ total: number; posterless: number }>(),
    ]);
    const swTotal = swCounts?.total ?? 0;
    const swEnriched = swTotal - (swCounts?.posterless ?? 0);
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
          <a href="/admin/screen-works">Release dates</a>
          <span class="meta" style="margin-left:auto">
            {swEnriched}/{swTotal} screen works enriched
          </span>
        </nav>
        <NewsQueuePage
          status={status}
          items={ordered}
          sources={sources}
          counts={counts}
          theme={themeOf(c)}
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
        theme={themeOf(c)}
      />,
    );
  });

  // Release-date editor (Track 1, Round 3): the calendar's data comes from
  // screen_works.release_date, and this table is the only place an owner can
  // set or clear it by hand. TBA-first ordering so undated works are fixed
  // first. Same admin-session gate as the queue.
  app.get('/admin/screen-works', async (c) => {
    const { results } = await c.env.DB
      .prepare(
        `SELECT id, title, kind, release_date, tmdb_id
           FROM screen_works
          ORDER BY (release_date IS NULL) DESC, release_date ASC, title ASC`,
      )
      .all<ReleaseDateRow>();
    const sessionUser = await getUser(c);
    const user: AuthUser = sessionUser
      ? { email: sessionUser.email, isAdmin: sessionUser.isAdmin }
      : null;
    return c.html(<ScreenWorksAdminPage works={results} user={user} theme={themeOf(c)} />);
  });

  // Owner-only: set or clear a screen work's release_date. Empty/absent body
  // clears to NULL (TBA); anything else must be a real YYYY-MM-DD date.
  app.post('/api/screen-works/:id/release-date', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: 'invalid screen work id' }, 400);
    }
    const body = await parseJsonBody(c);
    const raw =
      typeof body.release_date === 'string' ? body.release_date.trim() : '';
    let releaseDate: string | null = null;
    if (raw !== '') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        return c.json(
          { error: 'release_date must be YYYY-MM-DD (or empty to clear it)' },
          400,
        );
      }
      const parts = raw.split('-');
      const y = Number(parts[0]);
      const m = Number(parts[1]);
      const d = Number(parts[2]);
      const roundTrip = new Date(Date.UTC(y, m - 1, d));
      if (
        roundTrip.getUTCFullYear() !== y ||
        roundTrip.getUTCMonth() !== m - 1 ||
        roundTrip.getUTCDate() !== d
      ) {
        return c.json(
          { error: `release_date '${raw}' is not a real calendar date` },
          400,
        );
      }
      releaseDate = raw;
    }
    const existing = await c.env.DB
      .prepare('SELECT id FROM screen_works WHERE id = ?1')
      .bind(id)
      .first<{ id: number }>();
    if (!existing) {
      return c.json({ error: `screen work ${id} not found` }, 404);
    }
    await c.env.DB
      .prepare('UPDATE screen_works SET release_date = ?1 WHERE id = ?2')
      .bind(releaseDate, id)
      .run();
    return c.json({ ok: true, id, release_date: releaseDate });
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

    // Round 3 / Track 5: queue the adaptation's linked screen work for TMDB
    // poster enrichment when it has no poster yet. Only poster-less rows are
    // flagged (manually-set posters are never overwritten downstream); the
    // in-worker POST /admin/backfill/tmdb endpoint and the daily cron's
    // backstop sweep clear the flag once enrichment is attempted.
    // Requires migration 0013_enrichment_flag.sql.
    await c.env.DB
      .prepare(
        `UPDATE screen_works
            SET needs_enrichment = 1
          WHERE id = (SELECT screen_work_id FROM adaptations WHERE id = ?1)
            AND (poster_url IS NULL OR poster_url = '')`,
      )
      .bind(adaptationId)
      .run();

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

// ---------------------------------------------------------------------------
// Release-date editor (Track 1, Round 3)
// ---------------------------------------------------------------------------

/** Row shape for the release-dates admin table (snake_case DB convention). */
interface ReleaseDateRow {
  id: number;
  title: string;
  kind: string;
  release_date: string | null;
  tmdb_id: number | null;
}

/**
 * RELEASE_DATES_SCRIPT — interaction contract:
 *  - each form.release-date-form POSTs { release_date } (the date input's
 *    value; empty string clears the date back to TBA) as JSON to its
 *    data-path, then reloads the page;
 *  - auth rides the httpOnly session cookie (same-origin fetch) — no key
 *    parameter is threaded through links or sent in headers.
 */
const RELEASE_DATES_SCRIPT = `
document.querySelectorAll('form.release-date-form').forEach((form) => {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const res = await fetch(form.getAttribute('data-path'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ release_date: String(fd.get('release_date') || '') }),
    });
    let data = {};
    try { data = await res.json(); } catch (err) {}
    if (!res.ok) { alert('Error: ' + (data.error || res.status)); return; }
    location.reload();
  });
});
`;

function ScreenWorksAdminPage({
  works,
  user,
  theme,
}: {
  works: ReleaseDateRow[];
  user: AuthUser;
  theme?: ThemeName;
}) {
  return (
    <Layout title="Screen work release dates" user={user} theme={theme}>
      <nav class="tabs" aria-label="admin">
        <a href="/admin/news">News queue</a>
        <a class="active">Release dates</a>
      </nav>
      <h1 style="font-family:var(--serif);font-size:1.8rem;margin:0 0 .5rem">
        Release dates
      </h1>
      <p class="meta" style="margin-bottom:1.5rem">
        Powers the <a href="/calendar">release calendar</a> and the date shown
        on each <a href="/">screen work page</a>. Save sets the date; clearing
        the field and saving marks the work TBA.
      </p>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>Title</th>
              <th>Kind</th>
              <th>TMDB</th>
              <th>Release date</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {works.map((w) => (
              <tr key={w.id}>
                <td>
                  <a href={`/watch/${w.id}`}>{w.title}</a>
                </td>
                <td>{w.kind === 'series' ? 'Series' : 'Film'}</td>
                <td class="meta">{w.tmdb_id ?? '—'}</td>
                <td>
                  <form
                    class="release-date-form"
                    data-path={`/api/screen-works/${w.id}/release-date`}
                    style="display:flex;gap:.5rem;align-items:center"
                  >
                    <input
                      type="date"
                      name="release_date"
                      value={w.release_date ?? ''}
                      aria-label={`Release date for ${w.title}`}
                      style="font:inherit;padding:.4rem .6rem;border-radius:8px;border:1px solid var(--border);background:var(--bg-soft);color:var(--text)"
                    />
                    <button class="btn btn-sm" type="submit">
                      Save
                    </button>
                  </form>
                </td>
                <td class="meta">{w.release_date ?? 'TBA'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <script dangerouslySetInnerHTML={{ __html: RELEASE_DATES_SCRIPT }} />
    </Layout>
  );
}
