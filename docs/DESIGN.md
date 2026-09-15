# Novel Adaptations — Design Doc

> Rebuild of [noveladaptations.com](https://noveladaptations.com): the book-to-screen
> adaptation tracker. Fresh, modern, Cloudflare-native. This doc is the shared
> source of truth so multiple agents can work on the project coherently.
> Last updated: 2026-09-15.

## 1. Vision

No dominant book-to-screen tracker exists. Letterboxd covers films, Goodreads
covers books, adaptation news lives in editorial roundups, and
"optioned / in-development" tracking is literally one librarian's personal
spreadsheet. Novel Adaptations becomes the structured home for all of it:
every book-to-screen adaptation, its development status, community voting on
what *should* be adapted, and an autonomous news pipeline that surfaces
adaptation news as rumors or trusted items for human curation.

## 2. Core concepts

- **Book** — a literary work (novel, novella, etc.): title, author(s), cover,
  publication date, identifiers (ISBN, Open Library ID, Google Books ID).
- **Screen work** — a film or TV series: title, TMDB ID, poster, release date,
  cast/crew, type (film | series).
- **Adaptation** — the join between a book and a screen work, with a **status**:
  `rumored → optioned → in_development → filming → post_production → released`
  (+ `cancelled`). Each status change carries a source link. This pipeline is
  the killer feature — nobody consumer-facing does it.
- **Vote ("Make it a movie")** — users upvote books they want adapted; ranked
  "Most Wanted Adaptations" leaderboard. One vote per user per book,
  accounts required, votes withdrawable.
- **News item** — an adaptation-related news story with a **trust tier**:
  `trusted` (established outlets: Deadline, Variety, THR…) vs `rumor`
  (blogs, social, unverified). Autonomous agents ingest these daily; the site
  owner curates (promote / demote / dismiss).

## 3. Feature roadmap

### Phase 1 — Foundation (build now)
- Cloudflare Workers + Hono API + D1 (SQLite) schema: books, screen_works,
  adaptations, votes, news_items, sources, users.
- Minimal web UI: browse adaptations, adaptation detail pages, book detail pages.
- `wrangler.toml`, D1 migrations, README, local dev via `wrangler dev`.

### Phase 2 — Status pipeline + voting
- Adaptation status pipeline with per-change source links.
- "Vote: adapt this book" + Most Wanted leaderboard (Listopia-style: one vote
  per user per book, score-ranked).
- Watchlist / readlist shelves (Want to Read / Want to Watch / Done).

### Phase 3 — Autonomous news pipeline (the fun part)
- Scheduled Worker (cron trigger, daily) ingests RSS feeds: Deadline, Variety,
  THR, Collider, ScreenRant, BookRiot, Flickering Myth.
- Classifier assigns trust tier (`trusted` vs `rumor`) by source; dedupes
  against existing items; links items to books/adaptations where identifiable.
- Curation queue UI: owner approves / promotes / dismisses; promotions can
  flip an adaptation's status (e.g. rumor → optioned) with the source link.
- Per-title news feeds on adaptation pages.

### Phase 4 — Discovery & engagement
- Release-date calendar + "notify me" alerts.
- Book-vs-movie comparison pages ("which was better?" polls, read+watched
  checklists).
- Hype Meter (1–10 crowdsourced per upcoming title).
- Author/director pages, user lists (first-class, shareable), reading
  challenges ("12 adaptations in 12 months").
- Newsletter: "This week in adaptations."
- Spoiler-safe ratings/reviews (spoiler-blur toggles).
  - Reviews moderation (as of 2026-09-15): reviews are author-owned — authors
    can edit and delete their own reviews, and there is no reporting or admin
    triage UI for reviews yet. An admin review queue for reported reviews
    (report button, admin list, hide/remove actions) is future work; don't add
    reporting UI without pairing it with that queue.
- Affiliate monetization (Phase 4/5): book purchase links (Amazon Associates
  etc. — schema: `books.purchase_url_book`, migration 0009) and
  where-to-watch/purchase links for screen works
  (`screen_works.purchase_url_screen`, migration 0009). Requires explicit,
  compliant affiliate disclosure on every page that renders them (FTC
  disclosure, clear "we may earn a commission" labeling); legal/ethics review
  before enabling. No affiliate UI ships until disclosure is in place.

## 4. Tech stack

- **Runtime:** Cloudflare Workers. **Framework:** Hono. **DB:** D1 (SQLite)
  with migrations in `migrations/`. **Cache/state:** KV for API caches,
  R2 if we ever store assets.
- **Frontend:** start server-rendered (Hono JSX) or a light SPA — keep
  dependencies minimal and modern. No frameworks from 2016.
- **Auth:** Cloudflare Access or lightweight email-link auth (decide in
  Phase 2; votes need accounts).
- **Config:** `wrangler.toml` at repo root. Never commit secrets; use
  `wrangler secret` / `.dev.vars` (gitignored).

## 5. Data strategy ($0 to start)

1. **Seed:** Wikidata SPARQL — films' "based on" (P144) property + `imdb_id`
   → join to TMDB. A public dataset found 4,686 adaptations among 82,021
   movies this way. Book side: normalized (author, title) + fuzzy matching.
2. **Enrich films:** TMDB API (free non-commercial key, ~40 req/10s, posters /
   trailers / cast; **attribution required**; assume $149/mo commercial tier
   once monetized).
3. **Enrich books:** Google Books API (free, 1,000 queries/day — bulk import
   once, cache aggressively) backed by Open Library (free, no key, bulk dumps)
   and Hardcover GraphQL (free token, ~60 req/min, indie coverage + ratings).
4. **Long tail** (optioned/unreleased): the news pipeline (§2), not Wikidata.
5. Optional later: OMDb ($1+/mo Patreon) for aggregated critic scores.

## 6. Voting integrity

- Accounts required; one vote per book per account; votes withdrawable.
- Email verification + minimum account age before votes count.
- Rate-limit votes; burst detection with "virality circuit breakers" (freeze
  suspicious spikes for review).
- Keep "want adapted" votes separate from ratings.
- Public vote counts (sunlight deters sockpuppets). Don't over-engineer until
  abuse appears.

## 7. Repo layout

```
novel-adaptations/
├── docs/            # this design doc + future ADRs
├── legacy/          # the 2016 original, untouched, for reference
├── migrations/      # D1 migrations
├── src/             # Workers app (Hono)
│   ├── index.ts     # routes
│   ├── db/          # schema + queries
│   ├── news/        # ingestion pipeline (Phase 3)
│   └── ui/          # frontend
├── wrangler.toml
└── README.md
```

## 8. Working agreements (for agents)

- Small, reviewable commits; never force-push to `main`.
- Every external API call is cached (KV or D1) — respect rate limits.
- No secrets in code, logs, or chat. Tokens live in Secure Vault /
  `wrangler secret` only.
- Don't deploy to production without the owner's explicit go-ahead.
- Update this doc when a Phase's scope changes.

## 9. Sources & prior research

- Full landscape report: `~/workspace/research_notes/novel-adaptations-landscape-20260915-1832/report.md`
  (also published as a shareable page in the Muse library).
- Original concept: "Compare books with their movies, vote for new movies to
  be made" (2016 app).
