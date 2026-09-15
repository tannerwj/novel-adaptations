# Novel Adaptations — News Pipeline Spec (Phase 3)

> Autonomous adaptation-news ingestion: a daily Cloudflare Workers cron job
> that scrapes RSS feeds, classifies stories with an LLM behind Cloudflare
> AI Gateway, and fills a curation queue for the owner. Companion to
> `docs/DESIGN.md` (core concepts §2, roadmap Phase 3).
> Last updated: 2026-09-15.

## 1. Architecture

```
Cron trigger (daily 06:00 UTC, "0 6 * * *")
        │
        ▼
┌─────────────────────────────┐
│ news-worker (ScheduledWorker)│
│ 1. Fetch RSS/Atom feeds      │  8 sources, parallel, 15s timeout each
│ 2. Parse → normalize items   │  title, url, summary, published_at
│ 3. Dedupe (URL hash in D1)   │  skip anything already seen
│ 4. Keyword pre-filter        │  cheap pass: must smell like adaptation news
│ 5. LLM classify via AI       │  Gateway "novel-adaptations" → Workers AI
│    Gateway                    │  Llama 3.1 8B Instruct, JSON output
│ 6. Insert news_items          │  status='pending', trust tier from source
└─────────────────────────────┘
        │
        ▼
Curation queue (owner-only UI + API):
  approve → visible on per-title news feeds
  promote → approve AND advance a linked adaptation's status
            (e.g. rumored → optioned) with the source URL attached
  dismiss → hidden; recorded to train future filtering
```

The worker is deliberately split from the main web app: it only writes to D1.
All HTTP routes (`/admin/news`, `/api/news/...`) live in the main Hono app so
the scaffold team owns them. A prototype implementation lives at
`/tmp/news-pipe/prototype/news-worker.ts` (kept out of the repo until Phase 1
lands; merge it as `src/news/` then).

### 1.1 Cron configuration (wrangler)

```toml
[triggers]
crons = ["0 6 * * *"]

[[d1_databases]]
binding = "DB"
database_name = "novel-adaptations"
database_id = "<from wrangler d1 create>"

[ai]
binding = "AI"
```

Cron triggers are included on Workers Free and Paid (minimum interval 1 min).
06:00 UTC was chosen so US-evening entertainment news is included and the
owner curates with morning coffee (MDT).

### 1.2 Runtime flow (per run)

1. Load `sources` table (feed URLs, tiers, health).
2. `Promise.allSettled` fetch of all feeds — one feed failing never kills the run.
3. Parse each feed (hand-rolled RSS 2.0 / Atom parser; see §6 — no npm deps).
4. Normalize: strip HTML from summaries, resolve relative URLs, parse dates.
5. Dedupe: `sha256(url)` against `news_items.url_hash`; also title-normalized
   match (lowercase, strip punctuation) within the last 7 days to catch
   re-posts with tracking params.
6. Pre-filter keywords (see §4.2). Non-matching items are still recorded as
   `is_adaptation_news=0, status='dismissed'` (cheap, keeps the dedupe working
   without LLM cost).
7. For candidates: one `env.AI.run('@cf/meta/llama-3.1-8b-instruct', ...,
   { gateway: { id: 'novel-adaptations', skipCache: false } })` call each.
8. Insert results; update `sources.last_fetched_at` / failure counters.

A run is idempotent: re-running the same day inserts nothing new.

## 2. Sources & trust tiers

Trust tier is assigned **by source**, not by the LLM. The LLM only decides
whether a story is adaptation news and extracts structured facts.

| # | Source | Feed URL | Tier |
|---|--------|----------|------|
| 1 | Deadline | https://deadline.com/feed/ | `trusted` |
| 2 | Variety | https://variety.com/feed/ | `trusted` |
| 3 | The Hollywood Reporter | https://www.hollywoodreporter.com/feed/ | `trusted` |
| 4 | Collider | https://collider.com/feed/ | `reputable` |
| 5 | ScreenRant | https://screenrant.com/feed/ | `reputable` |
| 6 | BookRiot | https://bookriot.com/feed/ | `reputable` |
| 7 | /Film (SlashFilm) | https://www.slashfilm.com/feed/ | `reputable` |
| 8 | Flickering Myth | https://www.flickeringmyth.com/feed/ | `rumor` |

Tier semantics (shown in the UI as badges):
- `trusted` — established trade press. Eligible for one-click **promote**
  (status advance) by the owner.
- `reputable` — enthusiast press with editorial standards. Shown normally;
  promote allowed but the UI nudges the owner to corroborate.
- `rumor` — blogs/social/unverified. **Always rendered with a "Rumor" badge
  and never eligible for auto-promotion** — promotion requires the owner to
  manually attach a corroborating trusted source.

Feed health: `sources` tracks `consecutive_failures`. After 5 consecutive
failures a feed is paused (`is_active=0`) and flagged in the curation UI;
it resumes after a manual re-check or 7 days. The worker validates every feed
at runtime (HTTP 200 + parseable XML) so a dead/changed feed URL is caught on
the first run after it breaks, not by a human.

> Note (2026-09-15): feed URLs above are each site's canonical WordPress
> feed path. Direct fetch-verification was unavailable when this spec was
> written; the runtime health-check (§2, above) is the enforcement mechanism.
> If a URL 404s on first run, the run logs it and the curation UI surfaces it.

Candidate tier-3 additions (owner decision): r/books and r/movies "books
becoming movies" threads, BookTok roundup newsletters. Start without them;
social ingestion is a spam vector.

## 3. LLM classification via Cloudflare AI Gateway

### 3.1 Gateway setup (one-time, manual)

Create an AI Gateway named **`novel-adaptations`** (dashboard or API —
a read-only check on 2026-09-15 confirmed AI Gateway is available on the
account; no gateway with this name exists yet). Enable:
- **Caching** — identical title+summary inputs hit cache instead of the model.
- **Rate limiting** — cap e.g. 60 req/min as a backstop.
- **Logging** — full request/response logs for prompt iteration.

The worker calls Workers AI through the binding with the gateway attached:

```ts
const result = await env.AI.run(
  '@cf/meta/llama-3.1-8b-instruct',
  { messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `TITLE: ${title}\nSUMMARY: ${summary}` },
    ],
    max_tokens: 300, temperature: 0 },
  { gateway: { id: 'novel-adaptations', skipCache: false } }
);
```

Why Workers AI + Llama 3.1 8B Instruct: in-house, no third-party key,
cheap (§5), and plenty for a JSON extraction task. If quality disappoints,
the gateway makes swapping the model a config change, not a code change.

### 3.2 Prompt design

System prompt (kept short — cost scales with input tokens):

```
You are a classifier for Novel Adaptations, a tracker of books adapted into
films and TV series. Given a news headline and summary, decide whether it is
about a book being adapted for the screen.

Respond with ONLY a JSON object:
{
  "is_adaptation_news": true|false,
  "book_title": "title or null",
  "author": "author or null",
  "screen_kind": "film"|"series"|"unknown",
  "status_signal": "rumored"|"optioned"|"in_development"|"filming"|"post_production"|"released"|"none",
  "confidence": 0.0-1.0,
  "reason": "one short sentence"
}

Rules:
- "based on the novel", "adaptation of", "optioned the rights", "to star in
  the adaptation" → is_adaptation_news true.
- Casting/sequel news for an existing adaptation → true, status_signal from
  context (filming/post_production/released).
- Book reviews, author interviews, box-office reports with no adaptation
  angle → false.
- status_signal "rumored" only when the text hedges ("in talks", "eyed",
  "reportedly", "could").
- confidence < 0.5 → the item stays pending but is sorted to the bottom of
  the queue.
```

Deterministic decoding (`temperature: 0`, `max_tokens: 300`) keeps output
short and parseable. The worker validates the JSON shape with a schema
check; unparseable output → `confidence: 0`, item stays pending, logged.

### 3.3 Fallback: keyword heuristics

If `env.AI.run` throws (rate limit, model outage, gateway down), the run does
**not** fail. Each candidate is scored by heuristics instead:

- +2: "based on the novel|book", "adaptation of"
- +1: "optioned", "film rights", "tv rights", "in development", "casting",
  "to direct", "showrunner", "limited series"
- −2: "review:", "interview", "box office", "trailer" without adaptation terms

Score ≥ 2 → `is_adaptation_news=1, confidence=0.3, llm_model='heuristic'`.
The item is flagged `needs_review=1` so the owner knows it skipped the LLM.
Normal LLM classification resumes on the next run.

### 3.4 Prompt-injection note

Feed content is untrusted third-party text. It is only ever placed in the
**user** message, never the system prompt; the model is instructed to output
JSON only, and the worker schema-validates before inserting. Extracted
strings are stored as data and HTML-escaped on render. No feed content ever
becomes an instruction to the worker.

## 4. Pre-filter (before the LLM)

### 4.1 Dedupe

- Primary key: `url_hash = sha256(canonical_url)` (strip UTM/tracking params
  before hashing). UNIQUE constraint — the DB enforces it.
- Secondary: normalized title match within 7 days catches the same story
  re-posted under a new URL.

### 4.2 Keyword gate

An item reaches the LLM only if title+summary matches at least one
adaptation term AND one screen term:

- Adaptation terms: `novel`, `book`, `adaptation`, `based on`, `optioned`,
  `rights`, `author`
- Screen terms: `film`, `movie`, `series`, `show`, `tv`, `netflix`, `hulu`,
  `apple tv`, `casting`, `director`, `streaming`

This keeps LLM calls to roughly 10–30/day (§5) instead of ~200.

## 5. Cost estimate

Pricing (Cloudflare docs, verified 2026-09-15):
- Workers AI: **$0.011 / 1,000 neurons**; **10,000 neurons/day free** on both
  Free and Paid plans (resets 00:00 UTC).
- Token-denominated rate for Llama 3.1 8B: **$0.088 / 1M input tokens**,
  **$0.606 / 1M output tokens**.
- AI Gateway: free (caching, logging, rate limiting included).
- Cron triggers: included on Free/Paid; Workers Paid ($5/mo) includes 10M
  requests — a daily cron run is a rounding error.

Expected daily volume:
- ~8 feeds × ~20–30 items ≈ **160–240 items fetched/day**
- After URL-hash dedupe: ~60–100 genuinely new
- After keyword gate: **~10–30 LLM calls/day**

Per-call cost: ~450 input tokens ($0.00004) + ~150 output tokens ($0.00009)
≈ **$0.00013**. At 30 calls/day ≈ **$0.12/month** — two orders of magnitude
inside the free 10,000 neurons/day. Even 10× growth stays free. The only
real cost is the Workers plan itself ($0–5/mo).

## 6. Prototype

`/tmp/news-pipe/prototype/news-worker.ts` (dependency-light: hand-rolled
RSS 2.0/Atom parser with regex — no npm packages; ~250 lines) plus
`wrangler.snippet.toml` with the cron trigger, D1 binding, and AI binding.
Merge into the main scaffold as `src/news/` once Phase 1 lands; add the cron
to the main `wrangler.toml` at that point (one Worker, one cron — don't run
two Workers against the same D1 unnecessarily).

## 7. Curation API (for the scaffold team)

Suggested routes on the main Hono app (owner-only, behind auth):

- `GET /admin/news?status=pending` — queue, sorted by
  `trust_tier` then `confidence` desc, low-confidence last.
- `POST /api/news/:id/approve` — status → `approved` (appears on title feeds).
- `POST /api/news/:id/dismiss` — status → `dismissed` (+ optional reason;
  reasons feed future pre-filter tuning).
- `POST /api/news/:id/promote` — approve + set/advance the linked
  adaptation's status with `source_url`; requires the item to be
  `trusted`/`reputable`, or a manually attached corroborating URL for rumors.

## 8. Quality & abuse controls

- **Rumors stay labeled.** The `rumor` tier renders with a visible "Rumor"
  badge everywhere; the data model keeps `trust_tier` immutable from
  ingestion (only the owner can re-tier).
- **No auto-publishing of status changes.** The pipeline proposes; the owner
  disposes. Promotion is always one explicit click.
- **SLA:** pending items older than 30 days auto-dismiss (keeps the queue
  honest); the owner gets a count badge on the admin nav.
- **Circuit breakers:** feed paused after 5 consecutive failures (§2);
  gateway rate limit caps LLM spend (§3.1); per-run cap of 100 LLM calls —
  overflow stays pending for the next run.
- **Audit trail:** every status change on an adaptation records
  `changed_by` (owner vs pipeline-suggested) and the source URL.

## 9. Open questions for the owner

1. Start with all 8 feeds, or trim to the 3 trades + BookRiot first?
2. Should `reputable`-tier promotions require a corroborating trusted source
   like rumors do, or is one click enough?
3. Newsletter ("This week in adaptations") — digest from approved items?
   That's Phase 4, but the data model already supports it.
