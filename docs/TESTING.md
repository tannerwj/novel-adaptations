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
(`after()` handlers, clicks, navigation) is covered by the interactive
browser suite below.

## Interactive browser suite (`tests/e2e/browser/`)

`run.py` drives a real Chromium (chrome-for-testing headless shell) through
the deployed site and clicks the actual UI — the layer the Node suite can't
reach. Full details in `tests/e2e/browser/README.md`.

```bash
# Full interactive run against production:
/tmp/pw/bin/python tests/e2e/browser/run.py

# Logged-out + mobile flows only (no D1 token needed):
/tmp/pw/bin/python tests/e2e/browser/run.py --skip-auth

# One flow while debugging:
/tmp/pw/bin/python tests/e2e/browser/run.py --only watch_rate
```

How it works:

- Routes Chromium through `proxy_fwd.py`, a local CONNECT forwarder on
  `127.0.0.1:18080` (started automatically), because sandboxed Chromium
  can't complete the egress proxy's auth handshake itself. The sandbox
  proxy also MITMs TLS, so the suite launches with
  `--ignore-certificate-errors` — test-harness-only; production traffic has
  valid certs.
- Mints the same guarded `e2e-test@example.com` session via
  `tests/e2e/setup.mjs`, injects the `na_session` cookie into the browser
  context (token never logged), and always runs `tests/e2e/teardown.mjs` in
  a `finally`.
- Every flow gets a fresh page in a shared context: desktop 1440×900 authed,
  desktop 1440×900 anonymous, or mobile 390×844 (`is_mobile`, `has_touch`)
  anonymous.
- "No reload" is asserted with a `window.__alive` marker on every
  interaction — the SPA must never trigger a full page load.

What it covers (14 flows, all green against production): avatar menu +
logout; home 24→40 cards in place with **every poster image actually
loading** (scroll-triggered, catches broken TMDB artwork); Most Wanted vote
with live count +1; 4★ rating → persistence across reload → change to 2★;
"Book" poll vote with tally movement; spoiler review post → blurred until
revealed; list create → add item → item with poster on the detail page →
listed in /lists; shelf add → persist → change → visible on /shelves; logout
→ /lists redirects to /auth/login; mobile tabs (Home/Calendar/Most
Wanted/Search/More) with SPA navigation; More sheet + theme toggle; no
horizontal overflow and ≥40px tap targets on /, /calendar, /watch/38;
header theme toggle with persistence; header search → results → detail,
no reload.

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
- **Rating deletion** — there is no public `DELETE /ratings` endpoint;
  removal is covered by teardown's zero-leftover verification.
- **Hype meter** — not yet covered in either suite; follow the poll flow
  pattern to add it.
- **Lighthouse / perf budgets** — no automated mobile performance or
  accessibility audit yet; the browser suite asserts layout (no overflow,
  tap targets) but not timings.
