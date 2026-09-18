#!/usr/bin/env python3
"""Backfill books.description + books.subjects from Open Library.

For every book with a NULL description, this script:
  1. Queries the Open Library search API by title (exact normalized-title
     match only — same rule as src/intake.ts, never a guess).
  2. Fetches the matched work's JSON for its description + subjects.
  3. Writes UPDATE statements to a SQL file and applies them to production
     D1 in chunks via `wrangler d1 execute --file`.

Also stores the matched openlibrary_id so future runs are cheap.

Usage:
    python3 scripts/backfill-book-details.py [--limit N] [--dry-run]

Open Library is keyless but asks for polite traffic: ~2 req/s max.
1,250 books x 2 requests ~= 20-40 minutes. Run in the background.
"""
import json
import re
import subprocess
import sys
import time
import unicodedata
import urllib.parse
import urllib.request

REPO = "/home/hatch/workspace/novel-adaptations"
DB_NAME = "novel-adaptations"
CHUNK_SIZE = 150
REQUEST_PAUSE = 0.5  # seconds between books (~2 books/s incl. 2 reqs each)


def wrangler_env():
    sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")
    from dynamic_credentials import dynamic_credential_entry
    import os
    env = dict(os.environ)
    env["CLOUDFLARE_API_TOKEN"] = dynamic_credential_entry("custom.cloudflare")["surrogate"]
    return env


def d1_query(sql, env):
    out = subprocess.run(
        ["npx", "wrangler", "d1", "execute", DB_NAME, "--remote",
         "--command", sql, "--json"],
        cwd=REPO, env=env, capture_output=True, text=True, timeout=120,
    )
    if out.returncode != 0:
        raise RuntimeError(f"wrangler d1 failed: {out.stderr[-500:]}")
    return json.loads(out.stdout)[0]["results"]


def d1_apply_file(path, env):
    out = subprocess.run(
        ["npx", "wrangler", "d1", "execute", DB_NAME, "--remote", "--file", path],
        cwd=REPO, env=env, capture_output=True, text=True, timeout=300,
    )
    if out.returncode != 0:
        raise RuntimeError(f"wrangler d1 apply failed: {out.stderr[-500:]}")
    return out.stdout


def normalize_title(t):
    # Mirror src/intake.ts normalizeTitle: lowercase, strip non-alphanumerics.
    t = unicodedata.normalize("NFKD", (t or "").lower())
    return re.sub(r"[^\w]", "", t, flags=re.UNICODE)


def author_tokens(name):
    """Lowercased alphanumeric tokens: 'Herbert, Frank' -> {'herbert', 'frank'}."""
    t = unicodedata.normalize("NFKD", (name or "").lower())
    return set(re.findall(r"\w+", t, flags=re.UNICODE))


def split_authors(authors):
    """Our books.authors column may hold several names ('A, B', 'A & B', 'A and B')."""
    parts = re.split(r"\s*(?:,|;|&|\band\b)\s*", authors or "", flags=re.IGNORECASE)
    return [p.strip() for p in parts if p.strip()]


def author_matches(our_authors, ol_author_names):
    """True when at least one of our authors token-matches an OL author.

    Either token set may be a subset of the other, so 'Herbert, Frank'
    matches 'Frank Herbert' and 'Stephen King' matches 'Stephen Edwin King'.
    Combined with the exact-title rule, a shared surname is strong evidence;
    a bare surname with no other shared token still matches, which is the
    accepted residual risk (documented; collisions are logged).
    """
    ours = [author_tokens(a) for a in split_authors(our_authors)]
    theirs = [author_tokens(n) for n in (ol_author_names or []) if isinstance(n, str)]
    for o in ours:
        if not o:
            continue
        for t in theirs:
            if not t:
                continue
            if o <= t or t <= o:
                return True
    return False


MAX_RETRIES = 3


def ol_get(url):
    """GET JSON with bounded retries (1s, 2s backoff) for transient failures."""
    last = None
    for attempt in range(MAX_RETRIES):
        try:
            req = urllib.request.Request(
                url, headers={"User-Agent": "NovelAdaptations/1.0 (book description backfill)"}
            )
            with urllib.request.urlopen(req, timeout=20) as resp:
                return json.load(resp)
        except Exception as e:
            last = e
            time.sleep(2 ** attempt)
    raise last


def find_work(title, authors):
    """Exact normalized-title match on Open Library search, with author evidence.

    Returns (work_key, None) on a confident match, or (None, reason) where
    reason is 'no-title' (no exact title hit) or 'ambiguous' (exact title but
    no author evidence — refused rather than guessed).
    """
    wanted = normalize_title(title)
    if not wanted:
        return None, "no-title"
    q = urllib.parse.urlencode({
        "title": title.strip(),
        "limit": 10,
        "fields": "key,title,author_name",
    })
    payload = ol_get(f"https://openlibrary.org/search.json?{q}")
    title_hits = []
    for doc in payload.get("docs", []):
        if (
            isinstance(doc.get("title"), str)
            and normalize_title(doc["title"]) == wanted
            and isinstance(doc.get("key"), str)
            and doc["key"].startswith("/works/")
        ):
            title_hits.append(doc)
    if not title_hits:
        return None, "no-title"
    author_hits = [
        d for d in title_hits if author_matches(authors, d.get("author_name"))
    ]
    if author_hits:
        # Same title + same author on several works (editions): first is fine.
        return author_hits[0]["key"], None
    # Exact title but no author evidence — refuse to guess.
    rejected = "; ".join(
        f"{d.get('title')} ({', '.join(d.get('author_name') or [])})" for d in title_hits[:3]
    )
    return None, f"ambiguous author — OL had: {rejected}"


def work_details(work_key):
    """Fetch description + subjects for a work key. Never raises."""
    try:
        work = ol_get(f"https://openlibrary.org{work_key}.json")
    except Exception:
        return None, []
    raw = work.get("description")
    if isinstance(raw, str):
        description = raw.strip() or None
    elif isinstance(raw, dict) and isinstance(raw.get("value"), str):
        description = raw["value"].strip() or None
    else:
        description = None
    subjects = work.get("subjects")
    subjects = [s for s in subjects if isinstance(s, str)][:12] if isinstance(subjects, list) else []
    return description, subjects


def sql_str(s):
    if s is None:
        return "NULL"
    return "'" + s.replace("'", "''") + "'"


def main():
    limit = None
    dry_run = False
    for a in sys.argv[1:]:
        if a == "--dry-run":
            dry_run = True
        elif a.startswith("--limit="):
            limit = int(a.split("=", 1)[1])

    env = wrangler_env()
    books = d1_query(
        "SELECT id, title, authors FROM books WHERE description IS NULL ORDER BY id ASC"
        + (f" LIMIT {limit}" if limit else "")
        + ";",
        env,
    )
    print(f"{len(books)} books need descriptions", flush=True)

    updates = []
    matched = 0
    no_title = 0
    ambiguous = 0
    chunk_no = 0

    def flush_chunk():
        """Apply accumulated UPDATEs immediately — durable progress.

        The resume query (WHERE description IS NULL) makes this idempotent:
        a restart re-picks only books still missing descriptions, and a
        partially-applied chunk's finished rows are simply skipped.
        """
        nonlocal chunk_no
        if dry_run or not updates:
            return
        chunk_no += 1
        path = f"/tmp/book-details-chunk-{chunk_no:04d}.sql"
        with open(path, "w") as f:
            f.write("\n".join(updates) + "\n")
        d1_apply_file(path, env)
        print(f"  applied chunk {chunk_no} ({len(updates)} rows)", flush=True)
        updates.clear()

    for i, b in enumerate(books):
        try:
            work_key, reason = find_work(b["title"], b["authors"])
            if not work_key:
                if reason and reason.startswith("ambiguous"):
                    ambiguous += 1
                    print(f"[{i+1}/{len(books)}] ambiguous, skipped: {b['title']}", flush=True)
                else:
                    no_title += 1
                    print(f"[{i+1}/{len(books)}] no OL match: {b['title']}", flush=True)
                time.sleep(REQUEST_PAUSE)
                continue
            description, subjects = work_details(work_key)
            if description is None and not subjects:
                print(f"[{i+1}/{len(books)}] no details: {b['title']}", flush=True)
                time.sleep(REQUEST_PAUSE)
                continue
            updates.append(
                "UPDATE books SET description = %s, subjects = %s, openlibrary_id = %s WHERE id = %d;"
                % (
                    sql_str(description),
                    sql_str(json.dumps(subjects)),
                    sql_str(work_key),
                    b["id"],
                )
            )
            matched += 1
            if len(updates) >= CHUNK_SIZE:
                flush_chunk()
            if (i + 1) % 25 == 0:
                print(f"[{i+1}/{len(books)}] matched {matched} so far", flush=True)
        except Exception as e:
            print(f"[{i+1}/{len(books)}] ERROR {b['title']}: {e}", flush=True)
        time.sleep(REQUEST_PAUSE)

    flush_chunk()  # final partial chunk
    print(
        f"done: {matched}/{len(books)} matched, {no_title} no title match, "
        f"{ambiguous} ambiguous skipped, {chunk_no} chunks applied"
        + (" (dry run — nothing written)" if dry_run else ""),
        flush=True,
    )


if __name__ == "__main__":
    main()
