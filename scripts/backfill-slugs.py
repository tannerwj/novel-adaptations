#!/usr/bin/env python3
"""Deterministic slug backfill for migration 0020 (SEO permalink slugs).

Rules:
  screen_works: slugify(title) [+ '-' + year]      e.g. dune-part-two-2024
  books:        slugify(title) [+ '-' + first author]  e.g. dune-frank-herbert
  adaptations:  same base as their screen work (title + year)

Within each table, collisions get a stable numeric suffix (-2, -3, ...) with
the lowest id keeping the base slug. Deterministic: same input always yields
the same slugs.

Usage:
  python3 scripts/backfill-slugs.py --dry-run   # show samples, write nothing
  python3 scripts/backfill-slugs.py             # apply to production D1

Only touches the slug columns — no user, vote, persona, or content data.
"""

import json
import re
import sys
import unicodedata
import urllib.request

sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

ACCT = "83c27d7f9b8764a53148888203d434cb"
DB = "c5b38c69-8695-4841-8191-d004b323fdd6"
CRED = "custom.cloudflare"
HOSTS = ["api.cloudflare.com"]
BASE = f"https://api.cloudflare.com/client/v4/accounts/{ACCT}/d1/database/{DB}/query"
CHUNK_SIZE = 80  # rows per CASE-based bulk UPDATE


def d1(sql):
    """Run a single statement; returns the result object."""
    body = json.dumps({"sql": sql}).encode()
    req = urllib.request.Request(
        BASE,
        data=body,
        headers={"Content-Type": "application/json", "User-Agent": "muse-cloudflare-skill"},
    )
    add_surrogate_to_request(req, CRED, allowed_hosts=HOSTS)
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = read_json_response(resp)
    if not data.get("success"):
        raise RuntimeError(f"D1 error: {json.dumps(data.get('errors'))}")
    res = data["result"][0]
    if not res.get("success"):
        raise RuntimeError(f"D1 statement failed: {sql[:120]}: {res.get('error')}")
    return res


def select(sql):
    return d1(sql)["results"] or []


def slugify(text):
    text = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode()
    text = text.lower()
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    text = re.sub(r"-{2,}", "-", text)
    return text[:80].strip("-") or "untitled"


def year_of(release_date):
    m = re.match(r"(\d{4})", release_date or "")
    return m.group(1) if m else None


def first_author(authors):
    if not authors:
        return None
    first = re.split(r"\s+and\s+|[,;&]", authors, maxsplit=1, flags=re.IGNORECASE)[0].strip()
    first = re.sub(r"\s+", " ", first)
    return first or None


def cap(base, limit=90):
    """Keep a combined base short enough for collision suffixes (-2, -3, ...)."""
    return base[:limit].rstrip("-") or "untitled"


def dedupe(pairs):
    """pairs: [(id, base_slug)] in id order → ({id: unique_slug}, suffix_count)."""
    used = set()
    out = {}
    suffixed = 0
    for row_id, base in pairs:
        slug = base
        n = 2
        while slug in used:
            slug = f"{base}-{n}"
            n += 1
        if slug != base:
            suffixed += 1
        used.add(slug)
        out[row_id] = slug
    return out, suffixed


def build_slugs():
    works = select("SELECT id, title, release_date FROM screen_works ORDER BY id ASC")
    books = select("SELECT id, title, authors FROM books ORDER BY id ASC")
    adaps = select(
        "SELECT a.id, s.title, s.release_date FROM adaptations a "
        "JOIN screen_works s ON s.id = a.screen_work_id ORDER BY a.id ASC"
    )

    def screen_base(title, release_date):
        base = slugify(title)
        year = year_of(release_date)
        return cap(f"{base}-{year}") if year else base

    work_pairs = [(w["id"], screen_base(w["title"], w["release_date"])) for w in works]

    def book_base(title, authors):
        base = slugify(title)
        fa = first_author(authors)
        return cap(f"{base}-{slugify(fa)}") if fa else base

    book_pairs = [(b["id"], book_base(b["title"], b["authors"])) for b in books]
    adap_pairs = [(a["id"], screen_base(a["title"], a["release_date"])) for a in adaps]

    work_slugs, work_suffixed = dedupe(work_pairs)
    book_slugs, book_suffixed = dedupe(book_pairs)
    adap_slugs, adap_suffixed = dedupe(adap_pairs)

    return (
        {
            "screen_works": work_slugs,
            "books": book_slugs,
            "adaptations": adap_slugs,
        },
        {
            "screen_works": work_suffixed,
            "books": book_suffixed,
            "adaptations": adap_suffixed,
        },
    )


def main():
    dry_run = "--dry-run" in sys.argv
    slugs, suffix_counts = build_slugs()
    total = sum(len(v) for v in slugs.values())
    print(f"Computed {total} slugs "
          f"({len(slugs['books'])} books, {len(slugs['screen_works'])} works, "
          f"{len(slugs['adaptations'])} adaptations).")
    print(f"True collision suffixes (-2, -3, ...): {suffix_counts}")

    for table in ("books", "screen_works", "adaptations"):
        print(f"\n-- {table} (first 5)")
        for row_id in sorted(slugs[table])[:5]:
            print(f"   {row_id} -> {slugs[table][row_id]}")

    if dry_run:
        print("\nDry run: no writes.")
        return

    # Only write rows whose slug is NULL or different (idempotent re-runs).
    current = {}
    for table in slugs:
        rows = select(f"SELECT id, slug FROM {table}")
        current[table] = {r["id"]: r["slug"] for r in rows}

    # Bulk UPDATE via CASE — one statement per chunk (the D1 REST /query
    # endpoint takes a single statement). Slugs match ^[a-z0-9-]+$ by
    # construction and ids are ints; validated before inlining.
    safe = re.compile(r"^[a-z0-9-]{1,100}$")
    updates = []
    for table, mapping in slugs.items():
        for row_id, slug in mapping.items():
            assert isinstance(row_id, int) and safe.match(slug), (table, row_id, slug)
            if current[table].get(row_id) != slug:
                updates.append((table, row_id, slug))

    print(f"\nWriting {len(updates)} slug updates in chunks of {CHUNK_SIZE}...")
    by_table = {}
    for table, row_id, slug in updates:
        by_table.setdefault(table, []).append((row_id, slug))
    n_chunks = 0
    for table, pairs in by_table.items():
        for i in range(0, len(pairs), CHUNK_SIZE):
            chunk = pairs[i:i + CHUNK_SIZE]
            whens = " ".join(f"WHEN {rid} THEN '{slug}'" for rid, slug in chunk)
            ids = ",".join(str(rid) for rid, _ in chunk)
            sql = f"UPDATE {table} SET slug = CASE id {whens} END WHERE id IN ({ids})"
            res = d1(sql)
            n_chunks += 1
            print(f"  {table} chunk {n_chunks}: rows written={res.get('meta', {}).get('rows_written', '?')}")

    # Verify: no NULLs left, no duplicates.
    for table in slugs:
        nulls = select(f"SELECT COUNT(*) AS n FROM {table} WHERE slug IS NULL")[0]["n"]
        dups = select(
            f"SELECT COUNT(*) AS n FROM (SELECT slug FROM {table} "
            f"WHERE slug IS NOT NULL GROUP BY slug HAVING COUNT(*) > 1)")[0]["n"]
        print(f"  {table}: nulls={nulls} duplicate_slugs={dups}")
        assert nulls == 0 and dups == 0, f"verification failed for {table}"
    print("Backfill complete and verified.")


if __name__ == "__main__":
    main()
