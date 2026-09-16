# Data quality

## Invariant: `released` requires a past-or-today `release_date`

An adaptation may only carry `status = 'released'` when its screen work has a
`release_date` on or before today. This is enforced in two layers:

1. **Application** — `assertReleasedStatusAllowed()` in `src/db.ts` (imported
   directly by unit tests). `promoteNewsItem()` calls it before any promotion
   to `released`, so the news pipeline and any admin flow get a clear error
   instead of a silent bad write.
2. **Database** — triggers `trg_adaptations_released_insert` /
   `trg_adaptations_released_update` (migration `0021`). These are the backstop
   for bulk imports and offline scripts that write SQL directly.

### Why it exists

The overnight catalog expansion (40 → 1,249 titles) seeded nearly every
adaptation as `status='released'` unconditionally — no code path compared the
status against the release date. One row slipped through visibly wrong:
adaptation 1799, "Dune: Part Three", seeded `released` with
`release_date = '2026-12-15'` (a film that had not come out; corrected to
`post_production` on 2026-09-16 with a Wikipedia source). The seeding script
also stamped `adaptation_status_audit.created_at` with the release date rather
than the write time, which is why the audit trail looked odd for seeded rows.

Lesson for future bulk imports: never default `status` — derive it from the
release date (`released` only when the date is past), or leave the row in a
pre-release status and let the news pipeline promote it.

### Audit query

Run this after any bulk import or enrichment pass. It must return zero rows:

```sql
-- released but the screen work isn't out yet (or has no date at all)
SELECT a.id, a.slug, s.title, s.release_date
FROM adaptations a
JOIN screen_works s ON s.id = a.screen_work_id
WHERE a.status = 'released'
  AND (s.release_date IS NULL OR s.release_date > date('now'));
```

Date comparison is lexicographic on ISO `YYYY-MM-DD` strings (year-only
`YYYY` values sort before any full date of the same year, so they are treated
as past — acceptable for a backstop).
