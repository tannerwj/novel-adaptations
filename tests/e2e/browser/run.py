#!/usr/bin/env python3
"""Interactive browser regression suite for Novel Adaptations.

Real Chromium (chrome-for-testing headless shell) + real clicks against the
deployed site: session cookie injection, votes, star ratings, polls, spoiler
reviews, lists, shelves, logout, mobile tabs/sheet/layout, theme, search.

Usage:
    /tmp/pw/bin/python tests/e2e/browser/run.py [--base URL] [--skip-auth]
                                                [--only <flow>] [--executable-path PATH]

- Full run needs CLOUDFLARE_API_TOKEN (D1 session mint + teardown). The token
  is obtained via dynamic_credentials and never printed.
- --skip-auth runs only the logged-out/mobile flows (no token needed).
- Chromium cannot reach the internet directly in this sandbox; ensure_proxy()
  starts tests/e2e/browser/proxy_fwd.py on 127.0.0.1:18080 when needed and
  every launch goes through it.
- Exit 0 when all selected flows pass, 1 otherwise. Teardown always runs
  (finally) when setup ran.

Requires: playwright (`pip install playwright`) + a Chromium binary
(chrome-for-testing headless shell works; Playwright's own `install` may be
blocked by your egress proxy — pass --executable-path explicitly then).
"""
import argparse
import json
import os
import re
import socket
import subprocess
import sys
import time
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[2]
SHOTS = HERE / "screenshots"
DEFAULT_EXECUTABLE = (
    Path.home() / "workspace" / ".browsers" / "chrome-headless-shell-linux64" / "chrome-headless-shell"
)
BASE_DEFAULT = "https://noveladaptations.com"
PROXY_ADDR = ("127.0.0.1", 18080)

sys.path.insert(0, str(REPO_ROOT))  # noqa: E402  (not strictly needed; keeps imports local)

from playwright.sync_api import sync_playwright, expect  # noqa: E402


# --------------------------------------------------------------------------
# Environment: proxy forwarder, Cloudflare token, session setup/teardown
# --------------------------------------------------------------------------

_proxy_proc = None


def ensure_proxy():
    """Make sure the local CONNECT forwarder is listening; start it if not."""
    global _proxy_proc
    s = socket.socket()
    try:
        s.connect(PROXY_ADDR)
        s.close()
        return
    except OSError:
        pass
    finally:
        s.close()
    _proxy_proc = subprocess.Popen(
        [sys.executable, str(HERE / "proxy_fwd.py")],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    deadline = time.time() + 15
    while time.time() < deadline:
        s = socket.socket()
        try:
            s.connect(PROXY_ADDR)
            s.close()
            return
        except OSError:
            time.sleep(0.2)
        finally:
            s.close()
    raise RuntimeError("proxy forwarder on 127.0.0.1:18080 did not come up")


def cf_token():
    sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")
    from dynamic_credentials import dynamic_credential_entry

    return dynamic_credential_entry("custom.cloudflare")["surrogate"]


def d1_setup(base):
    """Mint a session for e2e-test@example.com via tests/e2e/setup.mjs."""
    env = dict(os.environ, CLOUDFLARE_API_TOKEN=cf_token(), BASE_URL=base)
    out = subprocess.run(
        ["node", "tests/e2e/setup.mjs"],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=180,
    )
    if out.returncode != 0:
        raise RuntimeError(f"setup.mjs failed: {out.stderr.strip()[-500:]}")
    creds = json.loads(out.stdout.strip().splitlines()[-1])
    assert creds["email"] == "e2e-test@example.com", "setup returned wrong user"
    return creds  # {userId, email, token} — token never printed


def d1_teardown(user_id):
    env = dict(os.environ, CLOUDFLARE_API_TOKEN=cf_token())
    out = subprocess.run(
        ["node", "tests/e2e/teardown.mjs", str(user_id)],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=180,
    )
    if out.returncode != 0:
        raise RuntimeError(f"teardown.mjs failed: {out.stderr.strip()[-500:]}")
    return out.stdout.strip()


# --------------------------------------------------------------------------
# Browser helpers
# --------------------------------------------------------------------------

class Ctx:
    def __init__(self, base, shots):
        self.base = base
        self.shots = shots


def mark_alive(page):
    page.evaluate("window.__alive='yes'")


def assert_no_reload(page, what):
    alive = page.evaluate("window.__alive")
    assert alive == "yes", f"full-page reload during {what} (SPA must not reload)"


# --------------------------------------------------------------------------
# Flows — desktop, logged in
# --------------------------------------------------------------------------

def flow_auth_header(page, c):
    page.goto(c.base + "/", wait_until="domcontentloaded")
    expect(page.locator("[data-user-menu-btn]")).to_be_visible(timeout=30000)
    assert page.locator('.site-header a[href="/auth/login"]').count() == 0, "login link visible while authed"
    page.locator("[data-user-menu-btn]").click()
    menu = page.locator("[data-user-menu]")
    expect(menu).to_be_visible(timeout=10000)
    expect(menu.locator("[data-logout]")).to_have_text("Log out")
    page.keyboard.press("Escape")
    expect(menu).to_be_hidden(timeout=10000)


def flow_home_load_more(page, c):
    page.goto(c.base + "/", wait_until="domcontentloaded")
    grid = page.locator("[data-home-grid]")
    expect(grid.locator(".poster-card")).to_have_count(24, timeout=30000)
    btn = page.locator("[data-load-more]")
    expect(btn).to_be_visible()
    assert "16 of 40 remaining" in btn.inner_text()
    mark_alive(page)
    btn.click()
    expect(grid.locator(".poster-card")).to_have_count(40, timeout=30000)
    assert page.locator("[data-load-more]").count() == 0, "load-more button still present after all 40 shown"
    # Scroll the whole grid so every lazy poster fires, then require all of
    # them to load — a broken TMDB artwork URL anywhere fails the suite.
    page.evaluate(
        """async () => {
            const cards = [...document.querySelectorAll('[data-home-grid] .poster-card')];
            for (const c of cards) { c.scrollIntoView({ block: 'center' }); await new Promise(r => setTimeout(r, 120)); }
        }"""
    )
    page.wait_for_function(
        """() => {
            const imgs = [...document.querySelectorAll('[data-home-grid] .poster-card .poster img')];
            return imgs.length > 0 && imgs.every(i => i.complete && i.naturalWidth > 0);
        }""",
        timeout=60000,
    )
    assert_no_reload(page, "load more")
    page.screenshot(path=str(c.shots / "home-load-more.png"))


def flow_book_vote(page, c):
    page.goto(c.base + "/most-wanted", wait_until="domcontentloaded")
    row = page.locator(".rank-row").first
    expect(row).to_be_visible(timeout=30000)
    vote_btn = row.locator("[data-vote-btn]")
    book_id = vote_btn.get_attribute("data-book-id")
    count_el = page.locator(f'[data-vote-count-for="book-{book_id}"]')
    before = int(count_el.inner_text().strip())
    mark_alive(page)
    vote_btn.click()
    expect(count_el).to_have_text(str(before + 1), timeout=15000)
    assert "voted" in (vote_btn.get_attribute("class") or "").split(), "vote button missing .voted"
    assert vote_btn.get_attribute("aria-pressed") == "true"
    assert "Voted" in vote_btn.inner_text()
    assert_no_reload(page, "book vote")


def flow_watch_rate(page, c):
    page.goto(c.base + "/watch/38", wait_until="domcontentloaded")
    widget = page.locator("[data-rating-widget]")
    expect(widget).to_be_visible(timeout=30000)
    assert widget.get_attribute("data-user-rating") == "0", "fresh test user should have no rating yet"
    mark_alive(page)
    widget.locator('[data-rating-star][data-value="4"]').click()
    expect(widget).to_have_attribute("data-user-rating", "4", timeout=15000)
    assert widget.locator(".star.filled").count() == 4, "expected 4 filled stars"
    assert_no_reload(page, "rating")
    page.reload(wait_until="domcontentloaded")
    widget = page.locator("[data-rating-widget]")
    expect(widget).to_have_attribute("data-user-rating", "4", timeout=30000)
    widget.locator('[data-rating-star][data-value="2"]').click()
    expect(widget).to_have_attribute("data-user-rating", "2", timeout=15000)
    assert widget.locator(".star.filled").count() == 2, "expected 2 filled stars after change"
    page.screenshot(path=str(c.shots / "watch-rated.png"))


def flow_adaptation_poll(page, c):
    page.goto(c.base + "/adaptations/38", wait_until="domcontentloaded")
    widget = page.locator("[data-poll-widget]")
    expect(widget).to_be_visible(timeout=30000)
    count_el = widget.locator('[data-poll-row="book"] .poll-count')
    before = int(count_el.inner_text().split("·")[0].strip())
    mark_alive(page)
    widget.locator('[data-poll-btn="book"]').click()
    expect(count_el).to_contain_text(f"{before + 1} ·", timeout=15000)
    btn = widget.locator('[data-poll-btn="book"]')
    assert btn.get_attribute("aria-pressed") == "true", "poll button not marked pressed"
    assert "mine" in (btn.get_attribute("class") or "").split()
    assert_no_reload(page, "poll vote")


def flow_spoiler_review(page, c):
    marker = "BROWSER-REVIEW-" + uuid.uuid4().hex[:8]
    page.goto(c.base + "/watch/38", wait_until="domcontentloaded")
    form = page.locator("form[data-review-form]")
    expect(form).to_be_visible(timeout=30000)
    form.locator('textarea[name="body"]').fill(
        f"{marker} The pacing sags in act two but the finale earns it. Posted by the browser suite."
    )
    form.locator('input[name="has_spoilers"]').check()
    mark_alive(page)
    form.locator('button[type="submit"]').click()
    item = page.locator("article.review-item", has_text=marker)
    expect(item).to_be_visible(timeout=30000)
    body = item.locator(".review-body")
    assert "spoiler-blurred" in (body.get_attribute("class") or ""), "spoiler body not blurred"
    toggle = item.locator("[data-spoiler-toggle]")
    expect(toggle).to_be_visible()
    toggle.click()
    assert "spoiler-blurred" not in (body.get_attribute("class") or ""), "spoiler reveal did not unblur"
    assert toggle.get_attribute("aria-expanded") == "true"
    assert_no_reload(page, "review submit + reveal")
    page.screenshot(path=str(c.shots / "spoiler-review.png"))


def flow_lists(page, c):
    name = "Browser Suite List " + uuid.uuid4().hex[:8]
    page.goto(c.base + "/lists", wait_until="domcontentloaded")
    form = page.locator("form[data-create-list]")
    expect(form).to_be_visible(timeout=30000)
    form.locator('input[name="title"]').fill(name)
    form.locator('textarea[name="description"]').fill("Created by the Playwright regression suite.")
    mark_alive(page)
    form.locator('button[type="submit"]').click()
    page.wait_for_url(re.compile(r"/lists/.+"), timeout=30000)
    assert_no_reload(page, "list creation")
    slug = page.url.rstrip("/").rsplit("/", 1)[-1]
    assert slug and slug != "lists", f"unexpected list URL {page.url}"
    add = page.locator("form[data-add-item]")
    expect(add).to_be_visible(timeout=15000)
    add.locator('select[name="target_type"]').select_option("screen_work")
    add.locator('input[name="target_id"]').fill("38")
    add.locator('input[name="note"]').fill("browser-suite item")
    add.locator('button[type="submit"]').click()
    expect(page.locator('[data-item-row] a[href="/watch/38"]')).to_be_visible(timeout=30000)
    assert_no_reload(page, "list add item")
    # poster art rendered for the item
    assert page.locator('[data-item-row] .thumb img, [data-item-row] .thumb .poster-art').count() >= 1
    page.screenshot(path=str(c.shots / "list-detail.png"))
    page.goto(c.base + "/lists", wait_until="domcontentloaded")
    expect(page.locator("[data-list-row]", has_text=name)).to_be_visible(timeout=30000)


def _shelf_change(page, value):
    """Change the shelf select and wait for the app's async POST to finish.

    The change handler POSTs to /api/v1/shelves asynchronously; reloading
    before it completes aborts the request, so we must wait for it.
    """
    with page.expect_response(
        lambda r: "/api/v1/shelves" in r.url and r.request.method == "POST",
        timeout=30000,
    ) as resp_info:
        page.locator("[data-shelf-select]").select_option(value)
    assert resp_info.value.ok, f"shelf POST failed: {resp_info.value.status}"


def flow_shelf(page, c):
    page.goto(c.base + "/books/38", wait_until="domcontentloaded")
    sel = page.locator("[data-shelf-select]")
    expect(sel).to_be_visible(timeout=30000)
    mark_alive(page)
    _shelf_change(page, "want_to_read")
    assert sel.evaluate("s => s.value") == "want_to_read"
    assert_no_reload(page, "shelf add")
    page.reload(wait_until="domcontentloaded")
    sel = page.locator("[data-shelf-select]")
    expect(sel).to_have_value("want_to_read", timeout=30000)
    _shelf_change(page, "read")
    page.reload(wait_until="domcontentloaded")
    sel = page.locator("[data-shelf-select]")
    expect(sel).to_have_value("read", timeout=30000)
    page.goto(c.base + "/shelves", wait_until="domcontentloaded")
    group = page.locator(".shelf-group", has_text="Read")
    expect(group.locator('a[href="/books/38"]')).to_be_visible(timeout=30000)


def flow_logout(page, c):
    page.goto(c.base + "/", wait_until="domcontentloaded")
    expect(page.locator("[data-user-menu-btn]")).to_be_visible(timeout=30000)
    page.locator("[data-user-menu-btn]").click()
    page.locator("[data-user-menu] [data-logout]").click()
    expect(page.locator('.site-header a[href="/auth/login"]')).to_be_visible(timeout=30000)
    page.goto(c.base + "/lists", wait_until="domcontentloaded")
    page.wait_for_url(re.compile(r"/auth/login"), timeout=30000)
    assert "next=" in page.url and "lists" in page.url, f"missing next param: {page.url}"


# --------------------------------------------------------------------------
# Flows — mobile, logged out
# --------------------------------------------------------------------------

def flow_mobile_tabs(page, c):
    page.goto(c.base + "/", wait_until="domcontentloaded")
    bar = page.locator(".tab-bar")
    expect(bar).to_be_visible(timeout=30000)
    labels = [t.strip() for t in bar.locator(".tab-label").all_inner_texts()]
    assert labels == ["Home", "Calendar", "Most Wanted", "Search", "More"], f"tab labels: {labels}"
    mark_alive(page)
    for href, label in [("/calendar", "Calendar"), ("/most-wanted", "Most Wanted"),
                        ("/search", "Search"), ("/", "Home")]:
        bar.locator(".tab-link", has_text=label).click()
        page.wait_for_url(c.base + href, timeout=30000)
    assert_no_reload(page, "mobile tab navigation")
    page.screenshot(path=str(c.shots / "mobile-home.png"))


def flow_mobile_more_sheet(page, c):
    page.goto(c.base + "/", wait_until="domcontentloaded")
    expect(page.locator(".tab-bar")).to_be_visible(timeout=30000)
    mark_alive(page)
    page.locator("[data-more-btn]").click()
    sheet = page.locator("[data-more-sheet]")
    expect(sheet).to_be_visible(timeout=10000)
    expect(sheet.locator("[data-logout]")).to_have_count(0, timeout=5000)
    expect(sheet.locator('a[href="/auth/login"]')).to_be_visible()
    before = page.evaluate("document.documentElement.getAttribute('data-theme')")
    sheet.locator("[data-theme-toggle]").click()
    page.wait_for_function(
        f"document.documentElement.getAttribute('data-theme') !== '{before}'", timeout=10000
    )
    assert_no_reload(page, "mobile theme toggle")
    page.screenshot(path=str(c.shots / "mobile-more-sheet.png"))
    page.keyboard.press("Escape")
    expect(sheet).to_be_hidden(timeout=10000)


def flow_mobile_layout(page, c):
    checks = [
        ("/", ".poster-card"),
        ("/calendar", ".shelf-group"),
        ("/watch/38", ".hero h1"),
    ]
    for path, probe in checks:
        page.goto(c.base + path, wait_until="domcontentloaded")
        expect(page.locator(probe).first).to_be_visible(timeout=30000)
        overflow = page.evaluate("document.documentElement.scrollWidth > window.innerWidth")
        assert not overflow, f"horizontal overflow on {path}"
    page.goto(c.base + "/", wait_until="domcontentloaded")
    tabs = page.locator(".tab-bar .tab-link").all()
    assert len(tabs) == 5, f"expected 5 tab targets, found {len(tabs)}"
    for t in tabs:
        bb = t.bounding_box()
        assert bb is not None, "tab target has no bounding box"
        assert bb["width"] >= 40 and bb["height"] >= 40, f"tap target too small: {bb}"


# --------------------------------------------------------------------------
# Flows — desktop, logged out
# --------------------------------------------------------------------------

def flow_theme_toggle(page, c):
    page.goto(c.base + "/", wait_until="domcontentloaded")
    meta = page.locator('meta[name="theme-color"]')
    before = page.evaluate("document.documentElement.getAttribute('data-theme')")
    before_meta = meta.get_attribute("content")
    assert before in ("light", "dark")
    mark_alive(page)
    page.locator('.site-header [data-theme-toggle]').click()
    expected = "dark" if before == "light" else "light"
    page.wait_for_function(
        f"document.documentElement.getAttribute('data-theme') === '{expected}'", timeout=10000
    )
    after_meta = meta.get_attribute("content")
    assert after_meta != before_meta, "theme-color meta did not change"
    assert after_meta == ("#0b0c10" if expected == "dark" else "#faf9f6"), f"unexpected meta {after_meta}"
    assert_no_reload(page, "theme toggle")
    page.reload(wait_until="domcontentloaded")
    persisted = page.evaluate("document.documentElement.getAttribute('data-theme')")
    assert persisted == expected, f"theme did not persist across reload ({persisted})"


def flow_search_flow(page, c):
    page.goto(c.base + "/", wait_until="domcontentloaded")
    form = page.locator(".site-header [data-header-search]")
    expect(form).to_be_visible(timeout=30000)
    form.locator('input[name="q"]').fill("dune")
    mark_alive(page)
    form.locator('button[type="submit"]').click()
    page.wait_for_url(re.compile(r"/search\?q=dune"), timeout=30000)
    results = page.locator("[data-search-results]")
    expect(results.locator("a", has_text="Dune").first).to_be_visible(timeout=30000)
    link = results.locator('a[href^="/books/"]').first
    expect(link).to_be_visible()
    link.click()
    page.wait_for_url(re.compile(r"/books/\d+"), timeout=30000)
    assert_no_reload(page, "search → detail navigation")


FLOWS = [
    # (name, needs_auth, mobile, fn)
    ("auth_header", True, False, flow_auth_header),
    ("home_load_more", True, False, flow_home_load_more),
    ("book_vote", True, False, flow_book_vote),
    ("watch_rate", True, False, flow_watch_rate),
    ("adaptation_poll", True, False, flow_adaptation_poll),
    ("spoiler_review", True, False, flow_spoiler_review),
    ("lists", True, False, flow_lists),
    ("shelf", True, False, flow_shelf),
    ("logout", True, False, flow_logout),
    ("mobile_tabs", False, True, flow_mobile_tabs),
    ("mobile_more_sheet", False, True, flow_mobile_more_sheet),
    ("mobile_layout", False, True, flow_mobile_layout),
    ("theme_toggle", False, False, flow_theme_toggle),
    ("search_flow", False, False, flow_search_flow),
]


def main():
    ap = argparse.ArgumentParser(description="Playwright browser regression suite")
    ap.add_argument("--base", default=BASE_DEFAULT)
    ap.add_argument("--executable-path", default=str(DEFAULT_EXECUTABLE))
    ap.add_argument("--skip-auth", action="store_true", help="logged-out flows only (no D1 token)")
    ap.add_argument("--only", default=None, help="run a single flow by name")
    args = ap.parse_args()
    base = args.base.rstrip("/")
    SHOTS.mkdir(exist_ok=True)

    selected = [f for f in FLOWS if (not args.only or f[0] == args.only)]
    if args.only and not selected:
        print(f"unknown flow: {args.only}\nchoices: {', '.join(f[0] for f in FLOWS)}")
        return 2
    if args.skip_auth:
        selected = [f for f in selected if not f[1]]
    needs_auth = any(f[1] for f in selected)

    ensure_proxy()
    exe = args.executable_path
    if not Path(exe).exists():
        print(f"chromium executable not found: {exe}\npass --executable-path")
        return 2

    creds = None
    if needs_auth:
        print("minting test session…")
        creds = d1_setup(base)
        print(f"session ready for {creds['email']} (user {creds['userId']})")

    ctx = Ctx(base, SHOTS)
    results = []
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(
                executable_path=exe,
                # --no-sandbox: running as root in the sandbox.
                # --ignore-certificate-errors: the sandbox egress proxy
                # MITMs TLS with its own CA (curl trusts it via
                # CURL_CA_BUNDLE, Chromium does not). Production traffic
                # has valid certs; this flag is test-harness-only.
                args=["--no-sandbox", "--ignore-certificate-errors"],
                proxy={"server": f"http://{PROXY_ADDR[0]}:{PROXY_ADDR[1]}"},
            )
            contexts = {}
            try:
                def get_page(need_auth, mobile):
                    key = (need_auth, mobile)
                    if key not in contexts:
                        if mobile:
                            bctx = browser.new_context(
                                viewport={"width": 390, "height": 844},
                                is_mobile=True,
                                has_touch=True,
                                device_scale_factor=2,
                            )
                        else:
                            bctx = browser.new_context(viewport={"width": 1440, "height": 900})
                        if need_auth:
                            bctx.add_cookies([{
                                "name": "na_session",
                                "value": creds["token"],
                                "domain": "noveladaptations.com",
                                "path": "/",
                            }])
                        contexts[key] = bctx
                    return contexts[key].new_page()

                for name, need_auth, mobile, fn in selected:
                    page = get_page(need_auth, mobile)
                    try:
                        fn(page, ctx)
                        results.append((name, True, ""))
                        print(f"  ✓ {name}")
                    except Exception as e:  # noqa: BLE001
                        msg = f"{type(e).__name__}: {e}".strip()[:600]
                        results.append((name, False, msg))
                        print(f"  ✗ {name}\n    {msg}")
                        try:
                            page.screenshot(path=str(SHOTS / f"FAIL-{name}.png"))
                        except Exception:  # noqa: BLE001
                            pass
                    finally:
                        page.close()
            finally:
                for bctx in contexts.values():
                    bctx.close()
                browser.close()
    finally:
        if creds:
            print("tearing down test user…")
            print(d1_teardown(creds["userId"]))

    passed = sum(1 for _, ok, _ in results if ok)
    print(f"\n{passed}/{len(results)} browser flows passed")
    for name, ok, msg in results:
        if not ok:
            print(f"  FAILED {name}: {msg}")
    return 0 if passed == len(results) and results else 1


if __name__ == "__main__":
    sys.exit(main())
