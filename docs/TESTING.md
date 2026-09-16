# E2E Regression Suite

`tests/e2e/` is a repeatable, dependency-free (plain Node 18+) regression
suite that exercises real user flows against the deployed site — both the
HTTP/API layer and the actual client render output.

## How to run it

```bash
# Full suite (logged-out + logged-in flows) against production:
CLOUDFLARE_API_TOKEN=<token> node tests/e2e/run.mjs

# Against a preview worker:
CLOUDFLARE_API_TOKEN=<token> node tests/e2e/run.mjs --base https://novel-adaptations.<acct>.workers.dev

# Logged-out flows only (no D1 token needed):
node tests/e2e/run.mjs --skip-auth

# Run a subset while debugging:
node tests/e2e/run.mjs --only calendar
```

Exit code is 0 when everything passes, 1 otherwise. Each flow prints ✓/✗
with the exact assertion that failed.

## How it works

- **`run.mjs`** — entry point. Runs `setup.mjs` → logged-out flows →
  logged-in flows → `teardown.mjs` (in a `finally`, so cleanup happens even
  when flows fail).
- **`setup.mjs`** — creates `e2e-test@example.com` in D1 (if missing) and
  mints a 30-day session exactly the way the app does (SHA-256 token hash in
  `sessions`, raw token as the `na_session` cookie). Verifies the session via
  `GET /api/v1/auth/me` before any flow runs.
- **`teardown.mjs`** — deletes every row the suite created (votes, shelf
  items, ratings, reviews, poll votes, lists + items, feedback, rate-limit
  rows, sessions, the user itself), then SELECTs every table back to prove
  zero rows remain. It **refuses** to delete unless the resolved row's email
  is exactly `e2e-test@example.com`, `is_admin = 0`, and the id is not 1 or 2.
- **`helpers.mjs`** — fetch wrappers, assertions, the mini-runner, and
  `loadClientViews()`.
- **`flows/logged-out.mjs` / `flows/logged-in.mjs`** — the flows.

### Testing the real front end without a browser

The SPA's views (`public/js/views/*.js`) are pure renderers: async functions
that fetch `/api/v1` and return `{ title, html }`. `loadClientViews()` imports
the **real client modules** into Node, rewires global `fetch` so their
relative `/api/v1/...` calls hit the target site (with the test session
cookie when logged in), and installs shims that fail loudly if a render path
touches the DOM. Tests then assert on the exact HTML strings users see —
card counts, button labels, widget states, spoiler markup. Event wiring
(`after()` handlers, clicks, navigation) still needs a live browser and is
out of scope here.

## What it covers

Logged-out (9 flows): home page + API pagination + client grid (24 cards,
Load more); search API + grouped client results + empty state; book / watch /
adaptation detail pages (titles, TMDB art, cross-links, logged-out rating
widget with no radio inputs); calendar buckets + year groupings; Most Wanted
render + 401 on logged-out vote; branded 404; bot prerender (Googlebot gets
OG tags, normal UA gets the shell); theme cookie → `data-theme` +
theme-color on first paint; OpenAPI JSON + `/api/docs`.

Logged-in (9 flows): session sanity; votes (vote / idempotent re-vote /
unvote); ratings (rate / change / summary); reviews (post with spoiler flag,
spoiler-blur treatment, delete); polls (vote / tally moves / change vote);
lists (create / add item / client detail view / delete); shelves (add / list /
remove); feedback submission; logout (session invalidated, 401 afterwards).

## Idempotency

Every created row carries a unique per-run marker (`Date.now().toString(36)`
in review bodies, list titles, feedback subjects). Teardown removes all of
them and verifies zero leftovers, so the suite is safe to re-run any time.
Rate-limit tables are cleaned too, so consecutive runs don't 429.

## Adding a flow

Add a `test('name', async (ctx) => { ... })` to the right file in
`tests/e2e/flows/`. `ctx` has `{ base, token, userId, email }`. Use the
`assert`/`eq`/`contains`/`notContains` helpers — assertion messages should say
what the user would see. For client-render assertions, `await loadClientViews()`
gives you `{ home, detail, listsViews, widgets, store }`; use
`setClientAuthed(store, { id, email })` before rendering logged-in views.

## Known gaps (deliberate)

- **Magic-link email delivery** — no inbox access in CI; verify manually.
- **Interactive browser behavior** — clicks, navigation, `after()` wiring,
  mobile taps, Lighthouse — needs a live browser.
- **Rating deletion** — there is no public `DELETE /ratings` endpoint;
  removal is covered by teardown's zero-leftover verification.
- **Hype meter** — not yet covered; follow the poll flow pattern to add it.
