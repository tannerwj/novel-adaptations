# Novel Adaptations — `/api/v1` Contract

The versioned JSON API powering the client-rendered SPA. All endpoints live under
`https://noveladaptations.com/api/v1` (and the same path on `www.` and preview hosts).
This is Phase 1 of the SSR→SPA conversion; the server-rendered pages and the existing
unversioned `/api/*` routes are untouched and remain the source of truth for behavior.

Source: `src/api/v1.ts` (mounted via `mountV1(app)` in `src/index.tsx`).

---

## Shared conventions

### Base

- All request/response bodies are JSON. Send `Content-Type: application/json` on
  requests with a body.
- JSON keys are **snake_case** everywhere in v1 (the unversioned `/api/*` routes mix
  conventions; v1 does not).

### Error envelope

Every error response uses this shape, with the matching HTTP status:

```json
{ "error": { "code": "snake_case_string", "message": "human readable" } }
```

| HTTP | Code | Meaning |
|------|------|---------|
| 400 | `validation_error` | (legacy only — v1 uses 422 for all validation failures) |
| 401 | `unauthorized` | No (or expired) session; sign in first |
| 401 | `invalid_token` | Magic-link token missing, expired, or already used |
| 403 | `forbidden` | Signed in, but not the owner / not an admin |
| 404 | `not_found` | Resource (or unknown `/api/v1/*` path) doesn't exist |
| 409 | `conflict` | State conflict (e.g. review or list item already exists) |
| 422 | `validation_error` | Bad input — the only validation status v1 uses |
| 429 | `rate_limited` | Per-user / per-IP / per-email rate limit hit |
| 500 | `internal_error` | Unexpected server failure |
| 503 | `email_not_configured` | Magic-link requested but no mail sender is configured |

Example:

```json
{ "error": { "code": "validation_error", "message": "rating must be an integer from 1 to 5." } }
```

### Pagination

List endpoints accept `?page=` (1-based, default 1) and `?per_page=` (default varies,
max 100) and return:

```json
{
  "data": [ ... ],
  "page": 1,
  "per_page": 24,
  "total": 137
}
```

`total` is the full result count, not just the page.

### IDs, dates, enums

- IDs are positive integers. List detail pages are addressed by `slug` (string).
- Dates: ISO 8601. `release_date` is `YYYY-MM-DD`; timestamps (`created_at`,
  `updated_at`, `published_at`) are UTC `YYYY-MM-DD HH:MM:SS`.
- Enums are lowercase strings; documented per endpoint.

### Auth

- Sessions ride the HttpOnly `na_session` cookie (30 days, `SameSite=Lax`,
  `Secure` on HTTPS). The SPA must send `credentials: 'same-origin'` (or `'include'`
  for cross-subdomain) on every fetch — there is no bearer-token mode.
- Auth-required endpoints answer **401** `unauthorized` when logged out;
  admin-only endpoints answer **401** when logged out, **403** `forbidden` when
  logged in but not an admin.
- `user` objects are `{ "id": 7, "email": "you@example.com", "is_admin": false }`.

---

## Auth

### `POST /api/v1/auth/magic-link`

Request a sign-in email. Body: `{ "email": "you@example.com" }`.

- `200` `{ "ok": true, "email": "you@example.com" }` — email sent.
- `200` `{ "ok": true, "email": "…", "dev_link": "https://…/auth/verify?token=…" }` —
  only when no mail sender is configured **and** the worker runs with
  `ENVIRONMENT=development|preview` (local dev convenience; never in production).
- `422` `validation_error` — bad email.
- `429` `rate_limited` — max 5 links per email per rolling hour.
- `503` `email_not_configured` — production without an onboarded sending domain.

### `POST /api/v1/auth/verify`

Consume a single-use magic token (the SPA shell flow; the legacy `GET
/auth/verify?token=` page redirect continues to work). Body: `{ "token": "…" }`.

- `200` + `Set-Cookie: na_session=…; HttpOnly` and `{ "user": { "id": 7, "email": "…", "is_admin": false } }`.
- `401` `invalid_token` — missing, expired, or already-used token.

### `GET /api/v1/auth/me`

- `200` `{ "user": { "id": 7, "email": "…", "is_admin": false } }`.
- `401` `unauthorized` — logged out.

### `POST /api/v1/auth/logout`

Destroys the server-side session and clears the cookie.

- `200` `{ "ok": true }` (always, even without a session).

---

## Home

### `GET /api/v1/home`

The aggregate behind the browse/home page. Query: `?status=` (optional adaptation
status filter), `?page=&per_page=` (default `per_page` 24).

```json
{
  "adaptations": { "data": [ …adaptation objects… ], "page": 1, "per_page": 24, "total": 8 },
  "stats": {
    "total_adaptations": 8,
    "total_books": 8,
    "total_screen_works": 8,
    "approved_news": 3
  }
}
```

### Adaptation object

```json
{
  "id": 1,
  "book_id": 1,
  "screen_work_id": 1,
  "status": "released",
  "source_url": "https://en.wikipedia.org/wiki/Dune:_Part_Two",
  "book_title": "Dune",
  "book_authors": "Frank Herbert",
  "book_cover_url": "https://covers.openlibrary.org/…",
  "screen_title": "Dune: Part Two",
  "screen_kind": "film",
  "screen_release_date": "2024-03-01",
  "screen_poster_url": null,
  "screen_backdrop_url": null
}
```

`status` ∈ `rumored|optioned|in_development|filming|post_production|released|cancelled`;
`screen_kind` ∈ `film|series`.

---

## Adaptations

### `GET /api/v1/adaptations`

Paginated list of adaptation objects (`?status=` filter, `?page=&per_page=`, default 24).

```json
{ "data": [ … ], "page": 1, "per_page": 24, "total": 8 }
```

### `GET /api/v1/adaptations/:id`

Full detail for the adaptation-story page.

```json
{
  "adaptation": { …adaptation object… },
  "timeline": [
    { "status": "optioned", "at": "2026-01-04 10:22:11", "source_url": "https://…" },
    { "status": "filming", "at": null, "source_url": null }
  ],
  "user_voted": true,
  "user_shelf": "want_to_watch",
  "poll": {
    "adaptation_id": 1,
    "counts": { "book": 12, "screen": 5, "both": 3, "undecided": 1 },
    "total": 21,
    "user_choice": "book"
  }
}
```

- `timeline` is the status history, oldest first (falls back to a single event with
  the current status when there is no audit trail).
- `user_voted` / `user_shelf` / `poll.user_choice` are `false` / `null` / `null`
  when logged out. `user_shelf` ∈ `want_to_read|read|want_to_watch|watched|null`.
- `404` `not_found` for a missing adaptation; `422` for a non-integer id.

---

## Books

### `GET /api/v1/books/:id`

```json
{
  "book": {
    "id": 1, "title": "Dune", "authors": "Frank Herbert",
    "cover_url": "https://…", "pub_date": "1965-08-01",
    "isbn": "9780441172719", "openlibrary_id": null, "googlebooks_id": null
  },
  "adaptations": [ …adaptation objects… ],
  "rating": { "average": 4.5, "count": 20 },
  "user_rating": 5,
  "user_voted": true,
  "user_shelf": "read",
  "reviews": { "data": [ …review objects… ], "page": 1, "per_page": 20, "total": 3 },
  "user_lists": [ { "id": 2, "title": "Desert epics" } ]
}
```

- `user_rating`, `user_voted`, `user_shelf` are `null`/`false`/`null` when logged out.
- Reviews are newest-first, paginated (`?page=&per_page=`, default 20).
- `404` `not_found` for a missing book.

---

## Screen works ("watch")

### `GET /api/v1/watch/:id`

```json
{
  "work": {
    "id": 1, "tmdb_id": 12345, "title": "Dune: Part Two", "kind": "film",
    "poster_url": null, "backdrop_url": null, "release_date": "2024-03-01",
    "synopsis": null, "purchase_url_screen": null,
    "adaptations": [ { "id": 1, "title": "Dune", "status": "released" } ],
    "books": [ { "id": 1, "title": "Dune", "authors": "Frank Herbert" } ]
  },
  "news": [ …news items… ],
  "watch_providers": {
    "flatrate": [ { "id": 8, "name": "Netflix", "logo": "https://image.tmdb.org/t/p/w92/…" } ],
    "rent": [], "buy": [],
    "link": "https://www.themovied.com/…"
  },
  "rating": { "average": 4.7, "count": 42 },
  "user_rating": 5,
  "reviews": { "data": [ … ], "page": 1, "per_page": 20, "total": 6 },
  "hype": { "average": 4.2, "count": 11, "user_level": 5 },
  "user_lists": [ { "id": 2, "title": "Desert epics" } ]
}
```

- `watch_providers` is `null` when the work has no TMDB id or nothing is cached/known
  (US region; 7-day D1 cache; never throws).
- `hype` is `null` for released works; present (possibly `{average:0,count:0,…}`)
  for unreleased ones. `user_level` is `null` when logged out.
- `404` `not_found` for a missing screen work.

---

## Most wanted & votes

### `GET /api/v1/most-wanted`

Books ranked by vote count (Listopia-style). Paginated (`?page=&per_page=`, default 100).

```json
{
  "data": [
    { "book_id": 6, "title": "Fourth Wing", "authors": "Rebecca Yarros",
      "cover_url": "https://…", "votes": 34, "user_voted": true }
  ],
  "page": 1, "per_page": 100, "total": 5
}
```

### `POST /api/v1/votes` (auth)

Body: `{ "book_id": 6 }`. Idempotent — re-voting doesn't consume rate budget.

- `200` `{ "voted": true, "votes": 34 }`.
- `401` `unauthorized` — logged out.
- `422` `validation_error` — bad `book_id`.
- `404` `not_found` — no such book.
- `429` `rate_limited` — 20 votes/day.

### `DELETE /api/v1/votes/:bookId` (auth)

Withdraw a vote (idempotent). `200` `{ "voted": false, "votes": 33 }`.

---

## Ratings

1–5 stars on books and screen works. Separate from votes.

### `GET /api/v1/ratings?target_type=book&target_id=1`

Public; `user_rating` is `null` when logged out.

```json
{ "target_type": "book", "target_id": 1, "average": 4.5, "count": 20, "user_rating": 5 }
```

### `POST /api/v1/ratings` (auth)

Body: `{ "target_type": "book", "target_id": 1, "rating": 5 }`.

- `200` `{ "target_type": "book", "target_id": 1, "average": 4.6, "count": 21, "user_rating": 5 }`.
- `422` `validation_error` — bad `target_type`/`target_id`/`rating` (1–5).
- `404` `not_found` — target doesn't exist.
- `429` `rate_limited` — 60 ratings/hour.

---

## Reviews

Spoiler-safe reviews, one per user per target. Review object:

```json
{
  "id": 9, "user_id": 7, "target_type": "book", "target_id": 1,
  "title": "Better than the film", "body": "…", "has_spoilers": false,
  "created_at": "2026-09-14 08:01:22", "updated_at": "2026-09-14 08:01:22",
  "author_id": 7, "author_email": "you@example.com"
}
```

### `GET /api/v1/reviews?target_type=book&target_id=1`

Public, newest first, paginated (`?page=&per_page=`, default 20):

```json
{ "target_type": "book", "target_id": 1, "reviews": { "data": [ … ], "page": 1, "per_page": 20, "total": 3 } }
```

### `POST /api/v1/reviews` (auth)

Body: `{ "target_type": "book", "target_id": 1, "title": "…", "body": "…", "has_spoilers": false }`
(`title` optional; body ≤ 5000 chars, title ≤ 120).

- `201` `{ "review": { … } }`.
- `409` `conflict` — already reviewed; response also carries `review_id` so the SPA
  can jump to editing: `{ "error": { "code": "conflict", "message": "…" }, "review_id": 9 }`.
- `404` `not_found` — target doesn't exist.
- `429` `rate_limited` — 20 reviews/hour.

### `PUT /api/v1/reviews/:id` (auth)

Edit your own review. Body: `{ "title": "…", "body": "…", "has_spoilers": true }`.

- `200` `{ "review": { …updated… } }`.
- `403` `forbidden` — not the author. `404` `not_found` — no such review.

### `DELETE /api/v1/reviews/:id` (auth)

- `200` `{ "ok": true, "id": 9 }`. `403`/`404` as above.

---

## Polls

Book-vs-screen polls; one implicit poll per adaptation, one changeable vote per user.

### `GET /api/v1/polls/:adaptationId`

Public.

```json
{
  "adaptation_id": 1,
  "counts": { "book": 12, "screen": 5, "both": 3, "undecided": 1 },
  "total": 21,
  "user_choice": "book"
}
```

`user_choice` is `null` when logged out / never voted. `404` for a missing adaptation.

### `POST /api/v1/polls/:adaptationId` (auth)

Body: `{ "choice": "book" }` — `choice` ∈ `book|screen|both|undecided`.

- `200` — same shape as GET with fresh counts and `user_choice`.
- `429` `rate_limited` — 30 poll votes/hour.

---

## Hype

Pre-release "how hyped are you?" meter (1–5) per screen work.

### `GET /api/v1/hype?screen_work_id=6`

Public.

```json
{ "screen_work_id": 6, "average": 4.2, "count": 11, "user_level": 5 }
```

`user_level` is `null` when logged out. `404` for a missing screen work.

### `POST /api/v1/hype` (auth)

Body: `{ "screen_work_id": 6, "level": 5 }`.

- `200` — same shape with fresh aggregate and `user_level`.
- `422` — bad `screen_work_id`/`level`; `429` `rate_limited` — 60 changes/hour.

(The server does not gate on released-ness; the widget is simply only shown for
unreleased works.)

---

## Lists

Shareable lists of books / screen works. List object:

```json
{
  "id": 2, "title": "Desert epics", "description": "…", "is_public": true,
  "slug": "desert-epics-k3x9qw", "item_count": 4,
  "created_at": "2026-09-10 12:00:00", "updated_at": "2026-09-10 12:00:00"
}
```

List-item object:

```json
{
  "id": 11, "target_type": "book", "target_id": 1, "position": 0,
  "note": "Read before the film", "title": "Dune", "subtitle": "Book · Frank Herbert",
  "image_url": "https://…", "href": "/books/1"
}
```

### `GET /api/v1/lists` (auth)

Your lists, newest first, paginated (`?page=&per_page=`, default 50).

### `POST /api/v1/lists` (auth)

Body: `{ "title": "Desert epics", "description": "…", "is_public": true }`
(`description` optional, `is_public` defaults to `true`).

- `201` `{ "id": 2, "slug": "desert-epics-k3x9qw" }`.
- `429` `rate_limited` — 20 lists/hour.

### `GET /api/v1/lists/:slug`

Public list detail. Private lists **404 for non-owners** (existence is never leaked).

```json
{
  "list": { …list object… },
  "items": [ …list-item objects… ],
  "is_owner": true
}
```

### `PUT /api/v1/lists/:id` (auth)

Partial update: `{ "title": "…", "description": "…", "is_public": false }`.
`200` `{ "ok": true }`; `403` not the owner; `404` no such list.

### `DELETE /api/v1/lists/:id` (auth)

`200` `{ "ok": true }`; `403`/`404` as above.

### `POST /api/v1/lists/:id/items` (auth)

Body: `{ "target_type": "book", "target_id": 1, "note": "…" }` (`note` optional, ≤ 500 chars).

- `201` `{ "id": 11 }`.
- `409` `conflict` — already on the list; `404` — list or target missing; `403` — not the owner.

### `PUT /api/v1/lists/:id/items` (auth)

Reorder. Body: `{ "order": [11, 9, 12] }` — item ids in the new order; unmentioned
items keep their relative order after them.

- `200` `{ "ok": true }`; `422` `validation_error` for unknown/duplicate ids.

### `DELETE /api/v1/lists/:id/items/:itemId` (auth)

- `200` `{ "ok": true }`; `404` list/item missing; `403` not the owner.

---

## Shelves

Personal tracking (`want_to_read|read|want_to_watch|watched`) on books and adaptations.

### `GET /api/v1/shelves` (auth)

```json
{ "shelves": [ { "target_type": "book", "target_id": 1, "title": "Dune", "shelf": "read" } ] }
```

### `POST /api/v1/shelves` (auth)

Add/move: `{ "target_type": "book", "target_id": 1, "shelf": "read" }`.
`200` `{ "ok": true }`; `404` target missing; `422` bad enum/id.

### `DELETE /api/v1/shelves` (auth)

Remove: `{ "target_type": "book", "target_id": 1 }`. `200` `{ "ok": true }`.

---

## Search

### `GET /api/v1/search?q=dune&limit=12`

Grouped results, each group capped at `limit` (default 12, max 12) hits.
Case-insensitive substring match; LIKE wildcards in the query match literally.
Empty query → `popular` suggestions instead of an error; no matches → empty groups
plus `popular` suggestions.

```json
{
  "q": "dune",
  "books": { "data": [ { "id": 1, "title": "Dune", "authors": "Frank Herbert" } ], "total": 1 },
  "screen_works": { "data": [ { "id": 1, "title": "Dune: Part Two", "kind": "film", "poster_url": null } ], "total": 1 },
  "adaptations": { "data": [ { "id": 1, "status": "released", "book_title": "Dune", "book_authors": "Frank Herbert", "screen_title": "Dune: Part Two", "screen_kind": "film" } ], "total": 1 },
  "popular": [ { "id": 6, "title": "Fourth Wing", "authors": "Rebecca Yarros", "cover_url": "https://…", "votes": 34 } ]
}
```

---

## Calendar

### `GET /api/v1/calendar`

Every screen work arranged by release date (UTC "today").

```json
{
  "today": "2026-09-15",
  "coming_soon": [ { "id": 6, "title": "Fourth Wing", "kind": "series", "release_date": "2027-01-15", "poster_url": null } ],
  "recently_released": [ … ],
  "tba": [ { "id": 7, "title": "The Midnight Library", "kind": "film", "release_date": null, "poster_url": null } ]
}
```

- `coming_soon`: `release_date >= today`, date-ascending. `recently_released`: the
  trailing 120 days, date-descending. `tba`: undated, title-ascending.
  Dated works older than 120 days stay off the calendar (still reachable via browse/detail).

---

## Feedback (public)

### `POST /api/v1/feedback`

Anonymous submission allowed; spam protection is the per-IP rate limit.

Body: `{ "type": "correction", "subject": "…", "body": "…", "proof_url": "https://…", "email": "me@x.com" }`
— `type` ∈ `feature|adaptation_tip|correction|other`; `subject` 3–120 chars;
`body` 10–5000 chars; `proof_url`/`email` optional but validated when present.

- `201` `{ "ok": true, "id": 42 }`.
- `422` `validation_error` — field failures.
- `429` `rate_limited` — 5 submissions/IP/hour.

### `GET /api/v1/admin/feedback` (admin)

Triage queue. Filters: `?type=` (one of the four), `?status=` (`new|reviewed|done`;
invalid → unfiltered). Paginated (`?page=&per_page=`, default 50).

```json
{
  "filters": { "type": null, "status": "new" },
  "feedback": { "data": [
    { "id": 42, "user_id": 7, "email": "me@x.com", "type": "correction",
      "subject": "…", "body": "…", "proof_url": null,
      "status": "new", "created_at": "2026-09-15 16:00:00" }
  ], "page": 1, "per_page": 50, "total": 3 },
  "counts": { "new": 3, "reviewed": 1, "done": 12 }
}
```

### `POST /api/v1/admin/feedback/:id/status` (admin)

Body: `{ "status": "reviewed" }` (`reviewed|done`).

- `200` `{ "ok": true, "id": 42, "status": "reviewed" }`.
- `404` `not_found` — no such item.

---

## News queue (admin)

News-item object (as stored; `is_adaptation_news` / `needs_review` are booleans):

```json
{
  "id": 5, "url": "https://…", "url_hash": "…", "title": "…", "summary": "…",
  "source": "Variety", "trust_tier": "trusted", "published_at": "2026-09-14 09:00:00",
  "status": "pending", "is_adaptation_news": true, "book_title": "Fourth Wing",
  "author": null, "screen_kind": "series", "status_signal": "in_development",
  "confidence": 0.92, "llm_model": "…", "needs_review": false,
  "dismiss_reason": null, "created_at": "2026-09-15 06:05:00"
}
```

`status` ∈ `pending|approved|dismissed`; `trust_tier` ∈ `trusted|reputable|rumor`.

### `GET /api/v1/admin/news?status=pending` (admin)

Paginated (`?page=&per_page=`, default 50); invalid `status` → `pending`.

```json
{
  "status": "pending",
  "items": { "data": [ … ], "page": 1, "per_page": 50, "total": 4 },
  "counts": { "pending": 4, "approved": 10, "dismissed": 2 }
}
```

### `POST /api/v1/admin/news/:id/approve` (admin)

`200` `{ "ok": true, "id": 5, "status": "approved" }`; `404` missing item.

### `POST /api/v1/admin/news/:id/dismiss` (admin)

Body: `{ "reason": "…" }` (optional, ≤ 500 chars).
`200` `{ "ok": true, "id": 5, "status": "dismissed" }`; `404` missing item.

### `POST /api/v1/admin/news/:id/promote` (admin)

Approve + advance a linked adaptation's status (writes an audit row; flags the
linked screen work for TMDB poster enrichment when poster-less).

Body: `{ "adaptation_id": 6, "status": "filming", "corroborating_url": "https://…" }`
— `adaptation_id` required; `status` optional (defaults to the next rung on the
promote ladder); `corroborating_url` **required** for `rumor`-tier items.

```json
{
  "ok": true, "news_item_id": 5, "adaptation_id": 6,
  "old_status": "in_development", "new_status": "filming",
  "source_url": "https://…"
}
```

`422` — missing/invalid `adaptation_id`, invalid `status`, missing corroboration
for rumors, or adaptation already at the top of the ladder. `404` — news item or
adaptation missing.

### `GET /api/v1/admin/news/runs` (admin)

Pipeline run observability, newest first, paginated (`?page=&per_page=`, default 50).

```json
{
  "runs": { "data": [
    { "id": 12, "started_at": "2026-09-15 06:00:00", "finished_at": "2026-09-15 06:04:11",
      "status": "ran", "feeds_ok": 9, "feeds_failed": 1, "items_fetched": 40,
      "items_new": 3, "items_skipped_cap": 0, "llm_calls": 12, "errors": null,
      "created_at": "2026-09-15 06:04:11" }
  ], "page": 1, "per_page": 50, "total": 12 }
}
```

`status` ∈ `ran|disabled|error`.

---

## Admin: TMDB enrichment & screen works

### `POST /api/v1/admin/backfill/tmdb?n=5` (admin)

Run one in-worker TMDB poster/backdrop enrichment batch (`n` 1–10, default 5).
Never overwrites a manually-set poster; per-item failures are counted, not fatal.

```json
{ "done": 5, "enriched": 4, "failed": 1, "remaining": 2 }
```

`422` `validation_error` for a bad `n` (non-integer or < 1); values above 10 are
clamped to 10. `500` `internal_error` if the batch itself fails.

### `GET /api/v1/admin/screen-works` (admin)

Release-date admin table: TBA-first ordering. Paginated (`?page=&per_page=`, default 100).

```json
{ "screen_works": { "data": [
  { "id": 6, "title": "Fourth Wing", "kind": "series", "release_date": null, "tmdb_id": null }
], "page": 1, "per_page": 100, "total": 8 } }
```

### `POST /api/v1/admin/screen-works/:id/release-date` (admin)

Set or clear a release date. Body: `{ "release_date": "2027-01-15" }` — empty
string or `null` clears back to TBA.

- `200` `{ "ok": true, "id": 6, "release_date": "2027-01-15" }`.
- `422` `validation_error` — malformed or non-real date. `404` `not_found` — no such work.

---

## Theme

### `POST /api/v1/theme`

Body: `{ "theme": "dark" }` (`light|dark`). Sets the 1-year `theme` cookie
(shared across apex/www on the production domain).

- `200` `{ "ok": true, "theme": "dark" }`.
- `422` `validation_error` for anything else.

---

## Route table (quick reference)

| Method | Path | Auth |
|---|---|---|
| POST | /api/v1/auth/magic-link | – |
| POST | /api/v1/auth/verify | – |
| GET | /api/v1/auth/me | session |
| POST | /api/v1/auth/logout | – |
| GET | /api/v1/home | – |
| GET | /api/v1/adaptations | – |
| GET | /api/v1/adaptations/:id | – |
| GET | /api/v1/books/:id | – |
| GET | /api/v1/watch/:id | – |
| GET | /api/v1/most-wanted | – |
| POST | /api/v1/votes | session |
| DELETE | /api/v1/votes/:bookId | session |
| GET | /api/v1/ratings | – |
| POST | /api/v1/ratings | session |
| GET | /api/v1/reviews | – |
| POST | /api/v1/reviews | session |
| PUT | /api/v1/reviews/:id | session (author) |
| DELETE | /api/v1/reviews/:id | session (author) |
| GET | /api/v1/polls/:adaptationId | – |
| POST | /api/v1/polls/:adaptationId | session |
| GET | /api/v1/hype | – |
| POST | /api/v1/hype | session |
| GET | /api/v1/lists | session |
| POST | /api/v1/lists | session |
| GET | /api/v1/lists/:slug | – (private lists 404 for non-owners) |
| PUT | /api/v1/lists/:id | session (owner) |
| DELETE | /api/v1/lists/:id | session (owner) |
| POST | /api/v1/lists/:id/items | session (owner) |
| PUT | /api/v1/lists/:id/items | session (owner) |
| DELETE | /api/v1/lists/:id/items/:itemId | session (owner) |
| GET | /api/v1/shelves | session |
| POST | /api/v1/shelves | session |
| DELETE | /api/v1/shelves | session |
| GET | /api/v1/search | – |
| GET | /api/v1/calendar | – |
| POST | /api/v1/feedback | – |
| POST | /api/v1/theme | – |
| GET | /api/v1/admin/news | admin |
| POST | /api/v1/admin/news/:id/approve | admin |
| POST | /api/v1/admin/news/:id/dismiss | admin |
| POST | /api/v1/admin/news/:id/promote | admin |
| GET | /api/v1/admin/news/runs | admin |
| POST | /api/v1/admin/backfill/tmdb | admin |
| GET | /api/v1/admin/screen-works | admin |
| POST | /api/v1/admin/screen-works/:id/release-date | admin |
| GET | /api/v1/admin/feedback | admin |
| POST | /api/v1/admin/feedback/:id/status | admin |

---

## SEO tradeoff (client-rendered SPA vs SSR)

Moving page rendering to the client changes what crawlers see; here's the honest ledger.

**What we lose**

- **First-paint content for crawlers.** Googlebot executes JS, but indexing is
  slower and less predictable than parsing SSR'd HTML; smaller/niche crawlers
  (and most social link-preview scrapers — iMessage, Discord, Slack) do **not**
  run JS, so shared `/books/:id` / `/watch/:id` / `/lists/:slug` links lose their
  rich previews unless we add a bot-aware prerender layer later.
- **Detail-page SEO depth.** Today every book/watch/adaptation page ships
  server-rendered copy, canonical tags, and Open Graph meta. The SPA shell serves
  one generic HTML shell per route; per-page meta must be injected client-side
  (invisible to non-JS consumers).

**What we keep**

- **`/sitemap.xml` and `/robots.txt` are still served** from the worker with the
  full URL inventory (static pages + every book, screen work, and adaptation).
  Canonical URLs are **unchanged** (`/books/:id`, `/watch/:id`, `/adaptations/:id`,
  `/lists/:slug`), so existing indexed URLs keep working.
- **History-API routing** keeps every view bookmarkable and shareable as a plain URL.
- All JSON the SPA needs is first-party, same-origin, and cache-friendly; page
  loads after the shell are single round-trips, so perceived performance improves.
- The legacy SSR pages remain live during the transition, so we can A/B or roll
  back per route without URL changes.

**Recommendation for later (not Phase 1):** if rich link previews or crawl depth
matter, add a bot-UA-sniffed prerender (serve the existing SSR pages to known
crawlers) rather than rebuilding SSR for humans.
