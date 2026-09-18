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
 *   3. POST /admin/backfill/tmdb-full?n=10 — bulk backfill for the catalog
 *      build-out: TMDB search (poster/backdrop/release date/synopsis) plus
 *      a watch-provider cache refresh per row, in small chunks. Registered
 *      in src/api/v1.ts under the same /admin/* gate.
 *
 * Guardrails (carried over from scripts/backfill-tmdb-posters.ts):
 *   - NEVER overwrites manually-set data. The poster/backdrop/release_date
 *     writes are CASE-guarded to fill only NULL/'' slots and tmdb_id only
 *     fills NULL, so a poster or date set between the SELECT and the UPDATE
 *     always wins. The needs_enrichment flag is cleared regardless (a
 *     separate statement).
 *   - Idempotent: re-running enriches only flagged or still-missing rows
 *     (posters, backdrops, tmdb_id, release_date).
 *   - Retry-capped: enrichment_attempts counts genuine no-match searches per
 *     row and selection requires attempts < 3, so unmatchable rows stop
 *     being retried and the bulk-backfill loop always converges
 *     (migration 0019). Network/API failures and missing-key runs never
 *     burn an attempt — they stay eligible for the next run.
 *   - Throttled: ~300 ms between TMDB calls (≈33 req/10 s, under the free
 *     tier's ~40/10 s cap).
 *   - Fail-soft: a no-match, API error, or timeout is counted as `failed`
 *     and the batch continues.
 *
 * All lookup logic keeps the injected-fetcher pattern from src/tmdb.ts, and
 * the batching/progress helpers are pure and exported for unit tests.
 */

import type { Hono } from 'hono';
import { requireAdminPage } from './auth/session';
import {
  enrichScreenWorkFromEnv,
  fetchCreditsById,
  fetchEnrichmentById,
  type EnrichOutcome,
  type TmdbEnrichment,
  type TmdbFetcher,
} from './tmdb';
import { fetchAndCacheProviders } from './watch_providers_cache';

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
  tmdb_id: number | null;
}

/**
 * One row for the full backfill: enrichment candidates plus rows that only
 * need their watch-provider cache refreshed. D1 returns 0/1 for the
 * computed flags — normalize to booleans when mapping.
 */
export interface FullBatchCandidate extends EnrichmentCandidate {
  needsEnrich: boolean;
  hasFreshProviders: boolean;
}

/** Batch progress, returned by both the endpoint and the cron backstop. */
export interface EnrichBatchResult {
  /** Rows attempted in this invocation. */
  done: number;
  /** Rows with a TMDB hit (poster write applied or safely skipped). */
  enriched: number;
  /** Rows with no TMDB match, no key, or an exception — counted, not fatal. */
  failed: number;
  /** Watch-provider cache writes in this invocation (0 when not requested). */
  providers_cached: number;
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
      `SELECT id, title, kind, release_date, tmdb_id
         FROM screen_works
        WHERE enrichment_attempts < 3
          AND (needs_enrichment = 1
               OR poster_url IS NULL OR poster_url = ''
               OR release_date IS NULL OR release_date = ''
               OR release_date GLOB '[0-9][0-9][0-9][0-9]')
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
        WHERE enrichment_attempts < 3
          AND (needs_enrichment = 1
               OR poster_url IS NULL OR poster_url = ''
               OR release_date IS NULL OR release_date = ''
               OR release_date GLOB '[0-9][0-9][0-9][0-9]')`,
    )
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Persist one TMDB hit. Every column write is guarded so manually-set data
 * is never overwritten — poster/backdrop/synopsis only fill empty slots,
 * tmdb_id only fills NULL, and release_date only fills NULL/''. The
 * needs_enrichment flag is cleared regardless so the row stops being
 * selected. Two statements on purpose: a single statement couldn't clear
 * the flag on a fully-guarded no-op path.
 */
async function applyEnrichment(
  db: D1Database,
  rowId: number,
  hit: TmdbEnrichment,
): Promise<void> {
  await db
    .prepare(
      `UPDATE screen_works
          SET poster_url = CASE WHEN poster_url IS NULL OR poster_url = ''
                               THEN ?1 ELSE poster_url END,
              backdrop_url = CASE WHEN backdrop_url IS NULL OR backdrop_url = ''
                                  THEN ?2 ELSE backdrop_url END,
              tmdb_id = COALESCE(tmdb_id, ?3),
              -- A year-only 'YYYY' placeholder (catalog build-out) is refined
              -- when TMDB knows the exact date; full dates are never touched.
              release_date = CASE WHEN release_date IS NULL OR release_date = ''
                                       OR release_date GLOB '[0-9][0-9][0-9][0-9]'
                                  THEN ?4 ELSE release_date END,
              synopsis = CASE WHEN synopsis IS NULL OR synopsis = ''
                              THEN ?5 ELSE synopsis END
        WHERE id = ?6`,
    )
    .bind(
      hit.posterUrl,
      hit.backdropUrl,
      hit.tmdbId,
      hit.releaseDate,
      hit.overview,
      rowId,
    )
    .run();
  await db
    .prepare(`UPDATE screen_works SET needs_enrichment = 0 WHERE id = ?1`)
    .bind(rowId)
    .run();
}

/**
 * Up to `n` rows for the full backfill: enrichment candidates first
 * (flagged, poster-less, dateless, or synopsis-less), then rows that only
 * need a watch-provider cache refresh (have a tmdb_id but no fresh cache
 * row). Each row carries which work it needs so the batch loop can skip
 * the TMDB search or the provider fetch independently.
 */
export async function selectFullBatch(
  db: D1Database,
  n: number,
): Promise<FullBatchCandidate[]> {
  const { results } = await db
    .prepare(
      `SELECT id, title, kind, release_date, tmdb_id,
              (needs_enrichment = 1
               OR poster_url IS NULL OR poster_url = ''
               OR release_date IS NULL OR release_date = ''
               OR release_date GLOB '[0-9][0-9][0-9][0-9]'
               OR synopsis IS NULL OR synopsis = '') AS needs_enrich,
              EXISTS (SELECT 1 FROM watch_provider_cache w
                       WHERE w.screen_work_id = screen_works.id
                         AND datetime(w.updated_at, '+7 days') >= datetime('now')
                     ) AS has_fresh_providers
         FROM screen_works
        WHERE enrichment_attempts < 3
          AND (needs_enrichment = 1
               OR poster_url IS NULL OR poster_url = ''
               OR release_date IS NULL OR release_date = ''
               OR release_date GLOB '[0-9][0-9][0-9][0-9]'
               OR synopsis IS NULL OR synopsis = ''
               OR (tmdb_id IS NOT NULL AND NOT EXISTS (
                     SELECT 1 FROM watch_provider_cache w
                      WHERE w.screen_work_id = screen_works.id
                        AND datetime(w.updated_at, '+7 days') >= datetime('now')))
              )
        ORDER BY needs_enrichment DESC, id ASC
        LIMIT ?1`,
    )
    .bind(n)
    .all<
      EnrichmentCandidate & { needs_enrich: number; has_fresh_providers: number }
    >();
  return (results ?? []).map((r) => ({
    id: r.id,
    title: r.title,
    kind: r.kind,
    release_date: r.release_date,
    tmdb_id: r.tmdb_id,
    needsEnrich: r.needs_enrich === 1,
    hasFreshProviders: r.has_fresh_providers === 1,
  }));
}

/** How many rows still need full-backfill work (post-batch `remaining`). */
export async function countRemainingFull(db: D1Database): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM screen_works
        WHERE enrichment_attempts < 3
          AND (needs_enrichment = 1
               OR poster_url IS NULL OR poster_url = ''
               OR release_date IS NULL OR release_date = ''
               OR release_date GLOB '[0-9][0-9][0-9][0-9]'
               OR synopsis IS NULL OR synopsis = ''
               OR (tmdb_id IS NOT NULL AND NOT EXISTS (
                     SELECT 1 FROM watch_provider_cache w
                      WHERE w.screen_work_id = screen_works.id
                        AND datetime(w.updated_at, '+7 days') >= datetime('now')))
              )`,
    )
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Enrich a concrete list of rows. Fetch and throttle are injected for
 * tests; production passes the worker globals and ENRICH_THROTTLE_MS.
 *
 * Rows may carry the FullBatchCandidate flags: `needsEnrich: false` skips
 * the TMDB search (the row only needs providers), and `hasFreshProviders:
 * true` skips the provider fetch. With `opts.withProviders`, every row
 * that ends up with a tmdb_id also gets its watch-provider cache
 * refreshed via fetchAndCacheProviders.
 */
export async function enrichRows(
  db: D1Database,
  apiKey: string | undefined,
  rows: (EnrichmentCandidate &
    Partial<Pick<FullBatchCandidate, 'needsEnrich' | 'hasFreshProviders'>>)[],
  fetcher: TmdbFetcher = fetch,
  throttleMs: number = ENRICH_THROTTLE_MS,
  opts?: { withProviders?: boolean },
): Promise<EnrichBatchResult> {
  const result: EnrichBatchResult = {
    done: 0,
    enriched: 0,
    failed: 0,
    providers_cached: 0,
  };
  const kindOf = (row: { kind: string }): 'film' | 'series' =>
    row.kind === 'series' ? 'series' : 'film';
  for (const row of rows) {
    result.done++;
    let tmdbId: number | null = row.tmdb_id;
    if (row.needsEnrich ?? true) {
      // No API key → nothing is attempted and nothing is counted: the row
      // stays eligible for a later run once a key exists.
      let outcome: EnrichOutcome = { status: 'not-attempted' };
      if (apiKey) {
        outcome = row.tmdb_id
          ? // Known TMDB identity: fetch by id so the metadata can never
            // mix with a different title's search hit.
            await fetchEnrichmentById(apiKey, kindOf(row), row.tmdb_id, fetcher)
          : await enrichScreenWorkFromEnv(
              { TMDB_API_KEY: apiKey },
              {
                title: row.title,
                kind: kindOf(row),
                year: extractYear(row.release_date),
              },
              fetcher,
            );
      }
      if (outcome.status === 'hit') {
        await applyEnrichment(db, row.id, outcome.hit);
        tmdbId = outcome.hit.tmdbId;
        result.enriched++;
      } else if (outcome.status === 'no-match') {
        result.failed++;
        // Genuine miss only: count the attempt so the backfill loop
        // converges. Failures stay eligible for retry.
        await db
          .prepare(
            `UPDATE screen_works
                SET enrichment_attempts = enrichment_attempts + 1
              WHERE id = ?1`,
          )
          .bind(row.id)
          .run();
      } else if (outcome.status === 'failed') {
        // Retryable failure: never burns an attempt, stays eligible.
        result.failed++;
        console.error(
          `enrichment failed for screen_work ${row.id} (${row.title}):`,
          outcome.message ?? 'unknown error',
        );
      }
      if (throttleMs > 0) await sleep(throttleMs);
    }
    if (
      opts?.withProviders &&
      apiKey &&
      tmdbId &&
      !(row.hasFreshProviders ?? false)
    ) {
      const cached = await fetchAndCacheProviders(
        db,
        apiKey,
        row.id,
        tmdbId,
        kindOf(row),
      );
      if (cached) result.providers_cached++;
      if (throttleMs > 0) await sleep(throttleMs);
    }
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
 * The full-backfill core: select rows needing enrichment and/or a
 * watch-provider cache refresh, then do both in one pass. Used by
 * POST /admin/backfill/tmdb-full.
 */
export async function runFullBatch(
  deps: EnrichmentDeps,
  n: number,
  fetcher: TmdbFetcher = fetch,
  throttleMs: number = ENRICH_THROTTLE_MS,
): Promise<EnrichBatchResult> {
  const rows = await selectFullBatch(deps.DB, n);
  return enrichRows(deps.DB, deps.TMDB_API_KEY, rows, fetcher, throttleMs, {
    withProviders: true,
  });
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

/* ------------------------------------------------------------------ */
/* Credits backfill (migration 0026): cast + director/creators + TMDB   */
/* audience score, one TMDB call per title via append_to_response=      */
/* credits. Identity-safe: only rows that already carry a tmdb_id are  */
/* selected, so the payload can only describe the stored identity.     */
/* ------------------------------------------------------------------ */

/** A screen work row awaiting credits enrichment. */
export interface CreditsCandidate {
  id: number;
  title: string;
  kind: string;
  tmdb_id: number;
}

/** Rows with a known TMDB identity but no cast data yet, oldest first. */
export async function selectCreditsBatch(
  db: D1Database,
  n: number,
): Promise<CreditsCandidate[]> {
  const { results } = await db
    .prepare(
      `SELECT id, title, kind, tmdb_id FROM screen_works
        WHERE tmdb_id IS NOT NULL AND cast_json IS NULL
        ORDER BY id ASC LIMIT ?1`,
    )
    .bind(n)
    .all<CreditsCandidate>();
  return results ?? [];
}

export async function countRemainingCredits(db: D1Database): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM screen_works
        WHERE tmdb_id IS NOT NULL AND cast_json IS NULL`,
    )
    .first<{ c: number }>();
  return row?.c ?? 0;
}

export interface CreditsBatchResult {
  done: number;
  enriched: number;
  failed: number;
}

/**
 * Enrich one batch of credits. Writes are NULL-guarded (cast_json IS NULL)
 * so a row enriched between SELECT and UPDATE keeps the first write; the
 * loop converges because every outcome either writes cast_json or leaves
 * the row eligible only on retryable failure. Missing-key runs attempt
 * nothing and count nothing.
 */
export async function runCreditsBatch(
  deps: EnrichmentDeps,
  n: number,
  fetcher: TmdbFetcher = fetch,
  throttleMs: number = ENRICH_THROTTLE_MS,
): Promise<CreditsBatchResult> {
  const result: CreditsBatchResult = { done: 0, enriched: 0, failed: 0 };
  const rows = await selectCreditsBatch(deps.DB, n);
  for (const row of rows) {
    result.done++;
    const kind = row.kind === 'series' ? 'series' : 'film';
    // No API key -> nothing is attempted and nothing is counted: the row
    // stays eligible for a later run once a key exists.
    const outcome = deps.TMDB_API_KEY
      ? await fetchCreditsById(deps.TMDB_API_KEY, kind, row.tmdb_id, fetcher)
      : { status: 'not-attempted' } as const;
    if (outcome.status === 'hit') {
      const c = outcome.credits;
      await deps.DB.prepare(
        `UPDATE screen_works
            SET cast_json = ?1,
                director = ?2,
                creators = ?3,
                tmdb_vote_average = ?4,
                tmdb_vote_count = ?5
          WHERE id = ?6 AND cast_json IS NULL`,
      )
        .bind(
          JSON.stringify(c.cast),
          c.director,
          c.creators,
          c.vote_average,
          c.vote_count,
          row.id,
        )
        .run();
      result.enriched++;
    } else if (outcome.status === 'no-match') {
      // Stale tmdb_id (TMDB 404): record empty cast so the credits loop
      // converges. The metadata backfill (keyed on posters/attempts, not
      // cast_json) can still repair the identity later.
      await deps.DB.prepare(
        `UPDATE screen_works SET cast_json = ?1 WHERE id = ?2 AND cast_json IS NULL`,
      )
        .bind(JSON.stringify([]), row.id)
        .run();
      result.failed++;
    } else if (outcome.status === 'failed') {
      // Retryable: never burns eligibility, stays in the queue.
      result.failed++;
      console.error(
        `credits enrichment failed for screen_work ${row.id} (${row.title}):`,
        outcome.message ?? 'unknown error',
      );
    }
    if (throttleMs > 0) await sleep(throttleMs);
  }
  return result;
}
