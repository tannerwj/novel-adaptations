# Novel Adaptations

A directory of books and their film/TV adaptations: which novels became movies
or series, what stage each adaptation is at, and where to follow its progress.
This repo is a fresh rebuild on **Cloudflare Workers + Hono + D1**,
server-rendered with Hono JSX.

## Phase 1 scope

- D1 schema: `books`, `screen_works`, `adaptations`, `news_items`
  (`users`/`votes` tables are stubs for Phase 2).
- Server-rendered browse + detail pages (`/`, `/adaptations/:id`, `/books/:id`)
  and a JSON list endpoint (`/api/adaptations`).
- Demo seed data: 8 famous adaptations covering `released`,
  `in_development`, `optioned`, and `rumored` statuses.

## Project structure

```
novel-adaptations/
├── docs/              # design doc — DO NOT EDIT (owner-owned)
├── legacy/            # the 2016-era original — DO NOT EDIT
├── migrations/        # D1 migrations (SQLite), applied by wrangler
│   ├── 0001_init.sql  # schema
│   └── 0002_seed.sql  # demo data
├── src/
│   ├── index.tsx      # Hono app + routes
│   ├── db.ts          # D1 data-access helpers (all SQL lives here)
│   └── ui.tsx         # Hono JSX components (Layout, HomePage, AdaptationPage, BookPage)
├── package.json
├── tsconfig.json
├── wrangler.toml      # worker config + D1 binding (database_id is a
│                      #   placeholder until production DB is created)
└── README.md
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

## Docs

- Full design: [`docs/DESIGN.md`](docs/DESIGN.md)
- News pipeline spec: [`docs/NEWS_PIPELINE.md`](docs/NEWS_PIPELINE.md)
- `legacy/` holds the 2016 original, preserved for reference.

## News pipeline (Phase 3)

A daily cron (`0 6 * * *`, 06:00 UTC) fetches 8 RSS feeds, dedupes,
pre-filters, classifies with Workers AI (Llama 3.1 8B via the
`novel-adaptations` AI Gateway; keyword-heuristic fallback if the LLM is
unavailable), and fills the owner curation queue at `/admin/news`.

**Owner curation key:** all `/admin/*` and `/api/news/*` routes are gated
behind a shared secret (constant-time compare, fail closed — real auth is a
Phase 2 item). Set it with:

```sh
npx wrangler secret put CURATION_KEY
```

Then open `https://noveladaptations.com/admin/news?key=<secret>` (or send
`X-Curation-Key: <secret>`). Queue actions: **approve**, **dismiss**,
**promote** (advances a linked adaptation's status one step — e.g.
`rumored → optioned` — writes an `adaptation_status_audit` row; rumor-tier
items require a `corroborating_url`). Pending items older than 30 days are
auto-dismissed at the start of each scheduled run.

> Note: the shared-secret gate is a stopgap. A future step will replace it
> with real auth + admin roles; **no new routes will be built on the
> `CURATION_KEY` gate.** (TMDB poster enrichment, for example, runs as a
> deploy-time script — see `docs/TMDB_BACKFILL.md` — not an admin route.)

**Admin auth:** the `/admin` curation UI is pending a real auth + admin-roles
implementation (future step, not this wave).

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
| `CURATION_KEY` | `npx wrangler secret put CURATION_KEY` | `/admin/*` and `/api/news/*` deny everything (fail closed) |
| `EMAIL` send binding (`[[send_email]]`) | `wrangler.toml` + owner onboards `noveladaptations.com` for Email Sending (see above) | Magic links are logged to the console; with `ENVIRONMENT=development` they're also shown on-screen; otherwise sign-in shows "not configured" |
| `TMDB_API_KEY` | operator's shell env when running the backfill script (never committed) | `src/tmdb.ts` enrichment no-ops without a key; see `docs/TMDB_BACKFILL.md` |
| `ENVIRONMENT` (`[vars]`) | `ENVIRONMENT = "development"` in `.dev.vars` (gitignored) | Defaults to fail-closed production behavior |

**Production deploy needs owner approval.** Don't run `wrangler deploy` or
touch the remote D1 without it.
