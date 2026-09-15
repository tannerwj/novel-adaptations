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

**Production deploy needs owner approval.** Don't run `wrangler deploy` or
touch the remote D1 without it.
