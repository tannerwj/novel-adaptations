/**
 * src/enrichment.ts — in-worker TMDB enrichment (Round 3, Track 5).
 *
 * Two entry points share one core:
 *   1. POST /admin/backfill/tmdb?n=5   — the primary, owner-driven path.
 *      Self-gated by requireAdminPage (logged-out → 303 /auth/login,
 *      non-admin → 403), the same proven middleware the curation routes use.
 *   2. The daily news cron calls sweepEnrichment() (src/news/ingest.ts) as
 *      a backstop after the pipeline work, wrapped in try/catch so a
 *      failing sweep never breaks the news run.
 *
 * Guardrails (carried over from scripts/backfill-tmdb-posters.ts):
 *   - NEVER overwrites manually-set data. The poster/backdrop/release_date
 *     writes are CASE-guarded to fill only NULL/'' slots and tmdb_id only
 *     fills NULL, so a poster or date set between the SELECT and the UPDATE
 *     always wins. The needs_enrichment flag is cleared regardless (a
 *     separate statement).
 *   - Idempotent: re-running enriches only flagged or still-missing rows
 *     (posters, backdrops, tmdb_id, release_date).
 *   - Throttled: ~300 ms between TMDB calls (≈33 req/10 s, under the free
 *     tier's ~40/10 s cap).
 *   - Fail-soft: per-item try/catch — a bad title, API error, or timeout is
 *     counted as `failed` and the batch continues.
 *
 * All lookup logic keeps the injected-fetcher pattern from src/tmdb.ts, and
 * the batching/progress helpers are pure and exported for unit tests.
 */

import type { Hono } from 'hono';
import { requireAdminPage } from './auth/session';
import {
  enrichScreenWorkFromEnv,
  type TmdbEnv,
  type TmdbFetcher,
} from './tmdb';

/** What registerEnrichmentRoutes (and sweepEnrichment's caller) need. */
export interface EnrichmentDeps {
  DB: D1Database;
  /** Worker secret (`wrangler secret put TMDB_API_KEY`). Absent → no-op. */
  TMDB_API_KEY?: string;
}

/** Route-registration binding bound: needs the DB and the TMDB key. */
export type EnrichmentBindings = {
  DB: D1Database;
  TMDB_API_KEY?: string;
};

/** One screen_works row queued for enrichment (SELECT column shape). */
export interface EnrichmentCandidate {
  id: number;
  title: string;
  kind: string;
  release_date: string | null;
}

/** Batch progress, returned by both the endpoint and the cron backstop. */
export interface EnrichBatchResult {
  /** Rows attempted in this invocation. */
  done: number;
  /** Rows with a TMDB hit (poster write applied or safely skipped). */
  enriched: number;
  /** Rows with no TMDB match, no key, or an exception — counted, not fatal. */
  failed: number;
}

/** Default `?n=` on the endpoint; max caps one invocation's TMDB spend. */
export const DEFAULT_BATCH_SIZE = 5;
export const MAX_BATCH_SIZE = 10;
/** ~33 req/10 s — under the TMDB free-tier ~40/10 s cap. */
export const ENRICH_THROTTLE_MS = 300;
/** How many rows the daily cron backstop sweeps per run. */
export const CRON_BATCH_SIZE = 5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Clamp the `?n=` query param. Default 5, max 10.
 * Pure — unit-tested.
 */
export function parseBatchSize(
  raw: string | undefined,
): { ok: true; n: number } | { ok: false; error: string } {
  if (raw === undefined || raw === '') return { ok: true, n: DEFAULT_BATCH_SIZE };
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    return { ok: false, error: '`n` must be an integer between 1 and 10' };
  }
  return { ok: true, n: Math.min(MAX_BATCH_SIZE, n) };
}

/**
 * Pull the release year from a `YYYY-MM-DD` (or `YYYY-…`) release_date, the
 * same extraction the operator poster script uses. Pure — unit-tested.
 */
export function extractYear(releaseDate: string | null): number | null {
  if (!releaseDate || !/^\d{4}/.test(releaseDate)) return null;
  return Number(releaseDate.slice(0, 4));
}

/**
 * Up to `n` rows needing enrichment: explicitly flagged rows first, then
 * anything still poster-less OR still missing a release date. Pure query —
 * unit-testable with a stub DB.
 */
export async function selectEnrichmentBatch(
  db: D1Database,
  n: number,
): Promise<EnrichmentCandidate[]> {
  const { results } = await db
    .prepare(
      `SELECT id, title, kind, release_date
         FROM screen_works
        WHERE needs_enrichment = 1
           OR poster_url IS NULL OR poster_url = ''
           OR release_date IS NULL OR release_date = ''
        ORDER BY needs_enrichment DESC, id ASC
        LIMIT ?1`,
    )
    .bind(n)
    .all<EnrichmentCandidate>();
  return results ?? [];
}

/** How many rows still need enrichment (post-batch `remaining` counter). */
export async function countRemaining(db: D1Database): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM screen_works
        WHERE needs_enrichment = 1
           OR poster_url IS NULL OR poster_url = ''
           OR release_date IS NULL OR release_date = ''`,
    )
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Persist one TMDB hit. Every column write is guarded so manually-set data
 * is never overwritten — poster/backdrop only fill empty slots, tmdb_id only
 * fills NULL, and release_date only fills NULL/''. The needs_enrichment
 * flag is cleared regardless so the row stops being selected. Two
 * statements on purpose: a single statement couldn't clear the flag on a
 * fully-guarded no-op path.
 */
async function applyEnrichment(
  db: D1Database,
  rowId: number,
  hit: {
    posterUrl: string;
    backdropUrl: string | null;
    tmdbId: number;
    releaseDate: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE screen_works
          SET poster_url = CASE WHEN poster_url IS NULL OR poster_url = ''
                               THEN ?1 ELSE poster_url END,
              backdrop_url = CASE WHEN backdrop_url IS NULL OR backdrop_url = ''
                                  THEN ?2 ELSE backdrop_url END,
              tmdb_id = COALESCE(tmdb_id, ?3),
              release_date = CASE WHEN release_date IS NULL OR release_date = ''
                                  THEN ?4 ELSE release_date END
        WHERE id = ?5`,
    )
    .bind(hit.posterUrl, hit.backdropUrl, hit.tmdbId, hit.releaseDate, rowId)
    .run();
  await db
    .prepare(`UPDATE screen_works SET needs_enrichment = 0 WHERE id = ?1`)
    .bind(rowId)
    .run();
}

/**
 * Enrich a concrete list of rows. Fetch and throttle are injected for
 * tests; production passes the worker globals and ENRICH_THROTTLE_MS.
 */
export async function enrichRows(
  db: D1Database,
  apiKey: string | undefined,
  rows: EnrichmentCandidate[],
  fetcher: TmdbFetcher = fetch,
  throttleMs: number = ENRICH_THROTTLE_MS,
): Promise<EnrichBatchResult> {
  const result: EnrichBatchResult = { done: 0, enriched: 0, failed: 0 };
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    result.done++;
    try {
      const hit = await enrichScreenWorkFromEnv(
        { TMDB_API_KEY: apiKey },
        {
          title: row.title,
          kind: row.kind === 'series' ? 'series' : 'film',
          year: extractYear(row.release_date),
        },
        fetcher,
      );
      if (hit) {
        await applyEnrichment(db, row.id, hit);
        result.enriched++;
      } else {
        // No key, no match, or network/API failure — counted, not fatal.
        result.failed++;
      }
    } catch (e) {
      result.failed++;
      console.error(
        `enrichment failed for screen_work ${row.id} (${row.title}):`,
        (e as Error).message,
      );
    }
    if (i < rows.length - 1 && throttleMs > 0) await sleep(throttleMs);
  }
  return result;
}

/**
 * The shared core: select a batch and enrich it. Used by the endpoint and
 * (via sweepEnrichment in src/news/ingest.ts) the daily cron backstop.
 */
export async function runEnrichmentBatch(
  deps: EnrichmentDeps,
  n: number,
  fetcher: TmdbFetcher = fetch,
  throttleMs: number = ENRICH_THROTTLE_MS,
): Promise<EnrichBatchResult> {
  const rows = await selectEnrichmentBatch(deps.DB, n);
  return enrichRows(deps.DB, deps.TMDB_API_KEY, rows, fetcher, throttleMs);
}

/**
 * Mount the owner-driven enrichment endpoint. Self-gating (the middleware is
 * applied inside this function) so registration order relative to the
 * curation routes doesn't matter.
 *
 * POST /admin/backfill/tmdb?n=5
 *   → { done, enriched, failed, remaining }
 * remaining = rows still needing enrichment AFTER this batch.
 */
export function registerEnrichmentRoutes<E extends EnrichmentBindings>(
  app: Hono<{ Bindings: E }>,
): void {
  // Same proven gate as the curation routes: logged-out → 303 /auth/login,
  // logged-in non-admin → 403.
  app.use('/admin/backfill/*', requireAdminPage);

  app.post('/admin/backfill/tmdb', async (c) => {
    const parsed = parseBatchSize(c.req.query('n'));
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    try {
      const batch = await runEnrichmentBatch(
        { DB: c.env.DB, TMDB_API_KEY: c.env.TMDB_API_KEY },
        parsed.n,
      );
      const remaining = await countRemaining(c.env.DB);
      return c.json({ ...batch, remaining });
    } catch (e) {
      console.error('/admin/backfill/tmdb failed:', (e as Error).message);
      return c.json({ error: 'enrichment batch failed' }, 500);
    }
  });
}
