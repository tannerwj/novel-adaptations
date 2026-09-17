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


def ol_get(url):
    req = urllib.request.Request(
        url, headers={"User-Agent": "NovelAdaptations/1.0 (book description backfill)"}
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.load(resp)


def find_work(title):
    """Exact normalized-title match on Open Library search. Returns work key or None."""
    wanted = normalize_title(title)
    if not wanted:
        return None
    q = urllib.parse.urlencode({
        "title": title.strip(),
        "limit": 10,
        "fields": "key,title,author_name",
    })
    payload = ol_get(f"https://openlibrary.org/search.json?{q}")
    for doc in payload.get("docs", []):
        if (
            isinstance(doc.get("title"), str)
            and normalize_title(doc["title"]) == wanted
            and isinstance(doc.get("author_name"), list)
            and doc["author_name"]
            and isinstance(doc.get("key"), str)
            and doc["key"].startswith("/works/")
        ):
            return doc["key"]
    return None


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
    for i, b in enumerate(books):
        try:
            work_key = find_work(b["title"])
            if not work_key:
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
            if (i + 1) % 25 == 0:
                print(f"[{i+1}/{len(books)}] matched {matched} so far", flush=True)
        except Exception as e:
            print(f"[{i+1}/{len(books)}] ERROR {b['title']}: {e}", flush=True)
        time.sleep(REQUEST_PAUSE)

    print(f"done: {matched}/{len(books)} matched", flush=True)
    if dry_run or not updates:
        print("(dry run — no SQL written)" if dry_run else "(nothing to apply)")
        return

    # Apply in chunks so no single D1 call gets too large.
    for n in range(0, len(updates), CHUNK_SIZE):
        chunk = updates[n : n + CHUNK_SIZE]
        path = f"/tmp/book-details-chunk-{n // CHUNK_SIZE}.sql"
        with open(path, "w") as f:
            f.write("\n".join(chunk) + "\n")
        d1_apply_file(path, env)
        print(f"applied chunk {n // CHUNK_SIZE + 1} ({len(chunk)} rows)", flush=True)
    print("all chunks applied", flush=True)


if __name__ == "__main__":
    main()
