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

2. **[OWNER] Fix the dark-mode toggle.** Known bug: the toggle flips the
   theme state but nothing visibly changes. All static paths check out
   (theme API returns 200 and sets the cookie; the deployed JS switches the
   DOM instantly; dark CSS variables exist), so this needs live-browser
   debugging — it could not be reproduced or fixed from the server side.

3. **[VERIFY] Confirm the daily news pipeline cron is firing.** The
   `0 6 * * *` trigger is registered on the production worker and
   `PIPELINE_ENABLED="1"`, but `pipeline_runs` in production D1 has **zero
   rows** — the scheduled handler records a row on every invocation, so it
   has never fired. Check `/admin/news/runs` after the next 06:00 UTC tick;
   if still empty, inspect the trigger in the Cloudflare dashboard
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

7. **Keep TMDB data fresh.** The 2026-09-15 backfill enriched 5 of 8 screen
   works (posters, backdrops, TMDB IDs, release dates). Three unreleased
   works — *Fourth Wing*, *The Midnight Library*, *A Court of Thorns and
   Roses* — have no TMDB match yet and show no poster/date; re-run
   **Admin → Screen works → Run backfill** (10 works per run) as new works
   are added or when those titles get TMDB entries.

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
