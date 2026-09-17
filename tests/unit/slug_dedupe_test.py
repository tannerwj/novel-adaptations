#!/usr/bin/env python3
"""Permalink-safety tests for scripts/backfill-slugs.py (finding 16).

Guards:
  1. dedupe() never assigns a slug that collides with a reserved
     (already-published) slug — the newcomer gets the numeric suffix.
  2. Reservation is per-table: the same slug can exist in different tables.
  3. Deterministic: same input → same output, lowest id keeps the base.

Run: python3 tests/unit/slug_dedupe_test.py
"""
import importlib.util
import sys

spec = importlib.util.spec_from_file_location(
    "backfill_slugs", "scripts/backfill-slugs.py"
)
mod = importlib.util.module_from_spec(spec)
# The module inserts a skill path and imports dynamic_credentials at top
# level; that must succeed for the import to work.
spec.loader.exec_module(mod)

fails = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail and not cond else ""))
    if not cond:
        fails.append(name)


# 1. A newcomer whose natural slug is taken by a published permalink gets -2.
out, _ = mod.dedupe([(2, "dune-part-two-2024")], reserved={"dune-part-two-2024"})
check("reserved slug is not stolen", out[2] == "dune-part-two-2024-2", f"got {out[2]}")

# 2. Without reservation the lowest id keeps the base slug.
out, suffixed = mod.dedupe([(1, "dune"), (2, "dune"), (3, "dune")])
check(
    "lowest id keeps base, later ids suffix",
    out == {1: "dune", 2: "dune-2", 3: "dune-3"} and suffixed == 2,
    f"got {out}",
)

# 3. Suffixes skip over reserved slugs too (no silent collision).
out, _ = mod.dedupe([(5, "dune")], reserved={"dune", "dune-2"})
check("suffix skips reserved -2", out[5] == "dune-3", f"got {out[5]}")

# 4. Deterministic across runs.
a, _ = mod.dedupe([(1, "neuromancer"), (9, "neuromancer")], reserved={"neuromancer-2"})
b, _ = mod.dedupe([(1, "neuromancer"), (9, "neuromancer")], reserved={"neuromancer-2"})
check("deterministic", a == b and a[1] == "neuromancer" and a[9] == "neuromancer-3", f"got {a}")

# 5. build_slugs only considers NULL-slug rows (inspect the filter logic).
import inspect

src = inspect.getsource(mod.build_slugs)
check(
    "build_slugs filters to NULL slugs",
    'if not w["slug"]' in src and 'if not b["slug"]' in src and 'if not a["slug"]' in src,
)
check(
    "build_slugs reserves existing slugs",
    "work_reserved" in src and "book_reserved" in src and "adap_reserved" in src,
)

# 6. slugify basics.
check("slugify", mod.slugify("Dune: Part Two") == "dune-part-two", mod.slugify("Dune: Part Two"))
check("year_of", mod.year_of("2024-03-01") == "2024" and mod.year_of(None) is None)

if fails:
    sys.exit(f"{len(fails)} FAILURES: {fails}")
print("all slug dedupe tests passed")
