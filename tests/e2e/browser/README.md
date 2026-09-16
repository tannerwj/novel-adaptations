# Browser regression suite

`run.py` drives a real Chromium through the deployed site and clicks the
actual UI — the interactive layer the Node suite (`tests/e2e/`) can't reach:
widget wiring, SPA navigation without reloads, mobile tabs/sheet/layout,
theme persistence, and the full logged-in journey (vote → rate → poll →
review → list → shelf → logout).

## Requirements

- Python 3.10+ with `playwright` (`pip install playwright`)
- A Chromium binary. Playwright's own `playwright install chromium` works on a
  normal network; in sandboxed environments where the browser CDN is blocked,
  use a chrome-for-testing headless shell and pass it explicitly:
  `--executable-path /path/to/chrome-headless-shell`
- The sandbox egress proxy: Chromium can't complete the proxy-auth handshake
  itself, so `run.py` routes it through `proxy_fwd.py`, a tiny local CONNECT
  forwarder on `127.0.0.1:18080` (started automatically if it isn't already
  running). It reads upstream credentials from `https_proxy` and never
  prints them.

## Running it

```bash
# Full suite against production (needs a Cloudflare API token for D1
# session setup/teardown — obtained automatically via dynamic_credentials):
/tmp/pw/bin/python tests/e2e/browser/run.py

# Logged-out + mobile flows only (no token needed):
/tmp/pw/bin/python tests/e2e/browser/run.py --skip-auth

# One flow while debugging:
/tmp/pw/bin/python tests/e2e/browser/run.py --only watch_rate

# Against a preview worker:
/tmp/pw/bin/python tests/e2e/browser/run.py --base https://novel-adaptations.<acct>.workers.dev
```

Exit 0 when every selected flow passes, 1 otherwise. Failures print the
assertion and leave a `screenshots/FAIL-<flow>.png` behind.

## How it works

1. `ensure_proxy()` — starts `proxy_fwd.py` if port 18080 isn't listening.
2. `d1_setup()` — shells out to `tests/e2e/setup.mjs` (same guarded test
   user, `e2e-test@example.com`) and injects the `na_session` cookie into the
   browser context. The token is parsed in-process and never logged.
3. Each flow gets a fresh page in a shared context: desktop 1440×900 authed,
   desktop 1440×900 anonymous, or mobile 390×844 (`is_mobile`, `has_touch`)
   anonymous.
4. `d1_teardown()` — shells out to `tests/e2e/teardown.mjs` in a `finally`,
   deleting every row the flows created and verifying zero leftovers.

"No reload" is asserted with a `window.__alive` marker: the SPA must never
trigger a full page load during clicks, votes, ratings, polls, reviews,
lists, shelves, tab switches, or theme toggles.

## Flows

| Flow | Auth | What it clicks |
|---|---|---|
| `auth_header` | yes | Avatar menu opens, contains Log out, no Log in link |
| `home_load_more` | yes | 24 → 40 cards in place, button disappears, every poster image loads, no reload |
| `book_vote` | yes | Most Wanted vote: count +1, `.voted` state, no reload |
| `watch_rate` | yes | Rate 4★ → persists across reload → change to 2★ |
| `adaptation_poll` | yes | Vote "Book": tally +1, pressed state, no reload |
| `spoiler_review` | yes | Post spoiler review: blurred until revealed, reveal works |
| `lists` | yes | Create list → add item → item w/ poster on detail → listed in /lists |
| `shelf` | yes | Shelf a book → persists → change shelf → visible on /shelves |
| `logout` | yes | Log out via menu → /lists redirects to /auth/login?next=… |
| `mobile_tabs` | no | Home/Calendar/Most Wanted/Search/More tabs, SPA navigation |
| `mobile_more_sheet` | no | More sheet opens, theme toggle flips `data-theme`, Esc closes |
| `mobile_layout` | no | No horizontal overflow on /, /calendar, /watch/38; ≥40px tap targets |
| `theme_toggle` | no | Header toggle flips theme + theme-color, persists after reload |
| `search_flow` | no | Header search → /search?q=dune → click result → detail, no reload |

Screenshots land in `tests/e2e/browser/screenshots/`.
