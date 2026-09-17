/**
 * src/news/curation_db.ts — release-date editor data layer (Track 1, Round 3).
 *
 * Pure .ts module (no JSX) shared by the legacy page route
 * (src/news/curation.tsx) and the v1 JSON API (src/api/v1.ts), so node unit
 * tests can import the API router without the SSR UI bundle.
 */

// ---------------------------------------------------------------------------
// Release-date editor (Track 1, Round 3)
// ---------------------------------------------------------------------------

/** Row shape for the release-dates admin table (snake_case DB convention). */
export interface ReleaseDateRow {
  id: number;
  title: string;
  kind: string;
  release_date: string | null;
  tmdb_id: number | null;
  slug: string | null;
}

/**
 * Release-date admin rows, TBA-first — shared by the legacy page route and
 * the v1 JSON API (src/api/v1.ts).
 */
export async function listScreenWorksForAdmin(db: D1Database): Promise<ReleaseDateRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, title, kind, release_date, tmdb_id, slug
         FROM screen_works
        ORDER BY (release_date IS NULL) DESC, release_date ASC, title ASC`,
    )
    .all<ReleaseDateRow>();
  return results ?? [];
}

/**
 * Validate a release_date body value: empty/absent clears to NULL (TBA);
 * anything else must be a real YYYY-MM-DD calendar date. Shared by the
 * legacy form route and the v1 JSON API.
 */
export function validateReleaseDate(
  raw: unknown,
): { ok: true; value: string | null } | { ok: false; error: string } {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (s === '') return { ok: true, value: null };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return { ok: false, error: 'release_date must be YYYY-MM-DD (or empty to clear it)' };
  }
  const parts = s.split('-');
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  const roundTrip = new Date(Date.UTC(y, m - 1, d));
  if (
    roundTrip.getUTCFullYear() !== y ||
    roundTrip.getUTCMonth() !== m - 1 ||
    roundTrip.getUTCDate() !== d
  ) {
    return { ok: false, error: `release_date '${s}' is not a real calendar date` };
  }
  return { ok: true, value: s };
}

/**
 * Queue the linked screen work for TMDB poster enrichment when a promote
 * leaves it poster-less (manually-set posters are never flagged). Shared by
 * the legacy promote route and the v1 JSON API. Requires migration 0013.
 */
export async function flagEnrichmentForAdaptation(
  db: D1Database,
  adaptationId: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE screen_works
          SET needs_enrichment = 1
        WHERE id = (SELECT screen_work_id FROM adaptations WHERE id = ?1)
          AND (poster_url IS NULL OR poster_url = '')`,
    )
    .bind(adaptationId)
    .run();
}
