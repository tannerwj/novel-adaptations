# Novel Adaptations

A directory of books and their film/TV adaptations: which novels became movies
or series, what stage each adaptation is at, and where to follow its progress.
Built on **Cloudflare Workers + Hono + D1**.

**Architecture:** the worker serves a single-page app. The client router
(`public/js/`) renders every page; **all** data flows through the JSON API
at `/api/v1/*` (`src/api/v1.ts`). Server-side rendering survives only for
crawlers/bots (prerendered HTML in `src/prerender.ts`) and the initial
shell/chrome (`src/spa/`). The old SSR route modules are retired — they
stay on disk only where `src/api/v1.ts` still reuses their helpers —
so treat `src/api/v1.ts` + `public/js/` as the source of truth.

## What's in the catalog

- `books`, `screen_works`, `adaptations` with a release-status pipeline
  (`rumored → optioned → in_development → filming → post_production → released`)
  guarded by a DB invariant (migrations `0021`/`0022`).
- Community: votes, 5-star ratings, spoiler-safe reviews, book-vs-screen
  polls, hype meter, shareable lists, shelves.
- News pipeline: daily cron classifies RSS items into the `/admin/news`
  curation queue (approve / dismiss / promote).
- Feedback system with an admin triage queue (`/admin/feedback`) and a
  metadata intake that turns adaptation tips into catalog records.
- TMDB enrichment (posters, dates, where-to-watch) with a 7-day D1 cache.

## Project structure

```
novel-adaptations/
├── docs/              # design doc — DO NOT EDIT (owner-owned)
├── legacy/            # the 2016-era original — DO NOT EDIT
├── migrations/        # D1 migrations (SQLite), applied by wrangler
│   └── 0001_init.sql … 0024_source_attempt_at.sql
├── src/
│   ├── index.tsx      # Hono app: SPA shell, SEO/prerender, cron
│   ├── api/v1.ts      # the JSON API (all client data flows through here)
│   ├── db.ts          # shared D1 helpers (books, works, adaptations…)
│   ├── reviews/ votes/ lists/ news/ feedback/ auth/  # feature modules
│   │                  #   (db.ts + routes reused by src/api/v1.ts)
│   ├── intake.ts      # feedback → catalog metadata intake
│   ├── enrichment.ts  # TMDB enrichment pipeline
│   ├── prerender.ts   # bot/crawler HTML snapshots
│   └── spa/           # server-rendered shell + header/footer chrome
├── public/
│   ├── js/            # the SPA: router, views, widgets, components
│   └── openapi.json   # API documentation
├── scripts/           # one-off ops scripts (slug backfill, TMDB backfill…)
└── tests/
    ├── unit/          # node --test suite (SQLite-backed regression tests)
    └── e2e/           # browser regression suite (18 flows)
```

## Run locally

```sh
npm install
npm run dev        # wrangler dev --local
```

Open http://localhost:8787/ (or the port wrangler picks). Local D1 applies
migrations automatically on dev start; if the seed data isn't there, apply
them manually with `npx wrangler d1 migrations apply --local DB` and restart.

Other scripts:

```sh
npm run typecheck  # tsc --noEmit
npm run deploy     # wrangler deploy (production — owner approval required)
```

Tests:

```sh
node --test "tests/unit/*.test.mjs"  # fast SQLite-backed unit/regression suite
node tests/e2e/run.mjs               # node E2E (logged-out flows; --live opts into authed flows)
python3 tests/e2e/browser/run.py      # browser E2E, 18 flows (pass --live for production writes)
```

E2E setup/teardown refuse production D1 writes unless `--live`/`E2E_LIVE=1`
is passed explicitly.

## Docs

- Full design: [`docs/DESIGN.md`](docs/DESIGN.md)
- News pipeline spec: [`docs/NEWS_PIPELINE.md`](docs/NEWS_PIPELINE.md)
- `legacy/` holds the 2016 original, preserved for reference.

## News pipeline (Phase 3)

A daily cron (`0 6 * * *`, 06:00 UTC) fetches 8 RSS feeds, dedupes,
pre-filters, classifies with Workers AI (Llama 3.1 8B via the
`novel-adaptations` AI Gateway; keyword-heuristic fallback if the LLM is
unavailable), and fills the owner curation queue at `/admin/news`.

**Admin access:** all `/admin/*` and `/api/news/*` routes require an admin
session (magic-link sign-in, fail closed — logged-out users are redirected to
`/auth/login`, non-admins get 403). Admin status is granted solely by the
`ADMIN_EMAILS` allow-list:

```sh
npx wrangler secret put ADMIN_EMAILS
# paste a comma-separated list of owner emails, e.g.
# you@example.com,co-owner@example.com
```

Then sign in via magic link at `/auth/login`; an **Admin** badge appears in
the header linking to `/admin/news`. Admin emails live only in the secret —
never in code — and the allow-list is checked on *every* successful sign-in,
so adding an email later promotes that user on their next login.

> Documented limitation: there is no demotion path. Removing an email from
> `ADMIN_EMAILS` does **not** revoke existing admins; revoke manually with
> `UPDATE users SET is_admin = 0 WHERE email = '…';` on the D1 database.

Queue actions: **approve**, **dismiss**, **promote** (advances a linked
adaptation's status one step — e.g. `rumored → optioned` — writes an
`adaptation_status_audit` row; rumor-tier items require a
`corroborating_url`). Pending items older than 30 days are auto-dismissed
at the start of each scheduled run.

## Email (Cloudflare Email Service)

Magic-link sign-in emails are sent with Cloudflare Email Service through the
`EMAIL` send binding — no third-party provider, no API keys to manage.

**Note:** Resend was previously considered for magic-link delivery but was
replaced by Cloudflare Email Service; `RESEND_API_KEY` references have been
removed from code and docs.

```toml
# wrangler.toml
[[send_email]]
name = "EMAIL"
allowed_sender_addresses = ["noreply@noveladaptations.com"]
```

Sender identity: `Novel Adaptations <noreply@noveladaptations.com>` on the
**apex domain** (`noveladaptations.com`). Onboarding a domain for Email
Sending only adds DNS records on the `cf-bounce` subdomain (MX/SPF/DKIM)
plus a `_dmarc` TXT — it never touches root MX records, so existing mail
flow is unaffected (and no existing mail records are configured on this
zone today). The binding is locked to the single sender address above.

**Owner action required before sign-in emails work in production:**
1. Dashboard → **Compute** → **Email Service** → **Email Sending** →
   **Onboard Domain** → pick `noveladaptations.com` → Done.
2. Redeploy the Worker (`npx wrangler deploy`).

**Local dev:** `wrangler dev --local` simulates the binding — sends are
logged and the message content is written to local files for inspection, no
email is delivered. Set `remote = true` on the binding if you want local
dev to send real emails through your Cloudflare account instead.

## Secrets & environment

| Secret / var | How to set | What happens when unset |
|---|---|---|
| `ADMIN_EMAILS` | `npx wrangler secret put ADMIN_EMAILS` | `/admin/*` and `/api/news/*` deny all non-admin sessions (fail closed); only verified sign-ins whose email is on the list become admins |
| `EMAIL` send binding (`[[send_email]]`) | `wrangler.toml` + owner onboards `noveladaptations.com` for Email Sending (see above) | Magic links are logged to the console; with `ENVIRONMENT=development` they're also shown on-screen; otherwise sign-in shows "not configured" |
| `TMDB_API_KEY` | operator's shell env when running the backfill script (never committed) | `src/tmdb.ts` enrichment no-ops without a key; see `docs/TMDB_BACKFILL.md` |
| `ENVIRONMENT` (`[vars]`) | `ENVIRONMENT = "development"` in `.dev.vars` (gitignored) | Defaults to fail-closed production behavior |

**Production deploy needs owner approval.** Don't run `wrangler deploy` or
touch the remote D1 without it.
