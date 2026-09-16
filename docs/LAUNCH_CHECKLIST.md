# Launch Checklist — Novel Adaptations

Last updated: 2026-09-15. Ranked by importance. Items marked **[OWNER]**
need the site owner's words or action; **[VERIFY]** need a live check after
deploy.

## Must-haves (do these before inviting real users)

1. **[OWNER] Finalize legal copy on `/privacy` and `/terms`.**
   These pages exist and are linked in the footer, but the copy is a minimal
   plain-language **DRAFT placeholder** describing what the site actually
   collects (account email, activity, session + theme cookies, cookieless
   analytics). The owner must review and replace it with proper policy
   language before real users create accounts. Do not launch with the draft
   copy.

2. **~~[OWNER] Fix the dark-mode toggle.~~ RESOLVED 2026-09-15.** The
   "known bug" report was a false alarm from an agent without browser
   access. Verified with a live browser on the production SPA (after the
   SPA conversion): the toggle flips dark → light → dark instantly with no
   page reload, and `data-theme` tracks the visible theme. Served CSS
   selectors are unescaped and valid; the pre-paint theme script defaults
   first-time visitors to light.

3. **[VERIFY] Confirm the daily news pipeline cron is firing.** The
   `0 6 * * *` trigger was verified **registered and healthy via the
   Cloudflare API on 2026-09-15** (not just in config). `pipeline_runs`
   has zero rows only because the first tick had not occurred yet — first
   expected fire **2026-09-16 06:00 UTC**. A 7am MDT check is scheduled to
   confirm the run executed and report feed health. If still empty after
   that, inspect the trigger in the Cloudflare dashboard
   (Workers → novel-adaptations → Triggers).

4. **[VERIFY] Confirm a magic-link email lands in a real inbox.** The
   production endpoint returns `ok:true` (tested 2026-09-15) and the Email
   Service binding is present, but end-to-end inbox delivery has not been
   confirmed with a real address. Until this is proven, nobody can sign up.

5. **[VERIFY] Run Lighthouse on `/` and one detail page** (images +
   accessibility). Not yet run — needs a real browser session. The Phase 1
   `srcset`/`sizes` work (w185–w780 poster variants, responsive sizes) is
   deployed, but unmeasured.

6. **[VERIFY] Submit the sitemap in Google Search Console** once live.
   `sitemap.xml` is generated dynamically and covers `/`, `/calendar`,
   `/most-wanted`, `/search`, `/feedback`, `/privacy`, `/terms`, and every
   book / watch / adaptation detail page. `robots.txt` points at it.

7. **Keep TMDB data fresh.** The backfill enriched 5 of the original 8
   screen works (posters, backdrops, TMDB IDs, release dates). Three
   unreleased works — *Fourth Wing*, *The Midnight Library*, *A Court of
   Thorns and Roses* — have no TMDB match yet and show no poster/date.
   After the 2026-09-15 content seeding (catalog grew 8 → 40 adaptations),
   the admin backfill was re-run for all new rows — see backfill results
   in the 2026-09-15 dated log. Re-run **Admin → Screen works → Run
   backfill** (10 works per run) as new works are added or when unmatched
   titles get TMDB entries.

   2026-09-16 catalog expansion: the catalog grew 40 → ~1,260 adaptations
   via a Wikidata harvest (films + TV series with P144 "based on" links to
   books/literary works, top-by-sitelinks per decade, stage works and video
   games excluded) enriched with Open Library book data. New rows carry
   year-only release dates that the TMDB backfill refines to exact dates;
   each newly-dated adaptation got a sourced "Released" timeline event.
   Re-run the backfill for any rows that still show year-only dates.

## Already verified (2026-09-15)

- Footer: no design-doc link, TMDB attribution present, Privacy/Terms links added.
- Bot prerendering: Googlebot/Twitterbot/Slackbot get route-specific
  title/meta/OG/Twitter tags with canonical URLs on `/`, `/watch/:id`,
  `/adaptations/:id`, `/books/:id`, `/lists/:slug` (public only); normal
  browsers get the SPA shell unchanged. Edge-cached 1h (`s-maxage=3600`,
  `X-NA-Prerender: bot`). Admin routes and private lists never prerender.
- OG fallback: `public/og-card.jpg` (1200×630) is used for `og:image` /
  `twitter:image` in the shell, the bot prerender fallback, and `seo.ts`.
- Auth edge cases: rate-limited magic links, single-use 15-minute tokens,
  consumed tokens report "invalid, expired, or already used", expired
  sessions resolve as logged out, logged-in users are redirected off
  `/auth/login`. Production sign-in endpoint responds `ok:true`.
- Private lists return 404 to non-owners at the API level (no existence leak).
- SPA 404 and error views exist with a home CTA; empty states throughout
  home, calendar, most-wanted, lists, detail, feedback, and admin pages.
- Footers are byte-identical between the server renderer
  (`src/spa/chrome.ts`) and the client renderer
  (`public/js/components.js`) — keep them in sync when editing.
- Cron schedule, `PIPELINE_ENABLED`, `[[send_email]]`, D1, AI bindings,
  observability, apex + www routes, and the single Cloudflare Web Analytics
  beacon all confirmed on the deployed worker.
- One analytics beacon only — do not add another.

## Nice-to-haves (after launch)

- An About/contact page (feedback is the only contact mechanism today).
- Sentry error tracking — needs an owner-supplied DSN (excluded until then).
- Respect `prefers-color-scheme` on first visit.
- Affiliate / buy links (schema columns already exist; UI parked until the
  owner says so).
- PWA manifest / service worker for installability and offline resilience.
- Consider per-list OG images for shared public lists.

## Notes for future work

- `public/og-card.jpg` is a generated asset — regenerate (don't upscale) if
  the brand changes.
- The admin backfill button calls `?n=10` (the API batch cap). Raising the
  cap means editing both `parseBatchSize` in `src/tmdb.ts` and the admin UI
  copy in `public/js/views/admin.js`.
- `docs/TMDB_BACKFILL.md` documents the endpoint contract and test evidence.
