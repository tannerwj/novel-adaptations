# src/retired — archived route modules

These are the SSR-era Hono route modules retired in the SPA cutover
(`src/index.tsx` header documents the cutover). **Nothing imports them.**
The live API is `src/api/v1.ts`; the live client is `public/js/`.

They are kept for reference only — do not add new code here, and do not
import them from live code. If you need a helper that only exists in one of
these files, extract it into the live feature module (`src/<feature>/db.ts`)
and import it from there instead (as was done for `BODY_MAX`/`TITLE_MAX`,
moved to `src/reviews/db.ts` on 2026-09-17).

| File | Original location | Status |
|---|---|---|
| `reviews-routes.ts` | `src/reviews/routes.ts` | Unmounted; constants extracted |
| `lists-routes.ts` | `src/lists/routes.ts` | Unmounted |
| `votes-routes.ts` | `src/votes/routes.ts` | Unmounted |
