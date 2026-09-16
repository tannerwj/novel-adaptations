#!/usr/bin/env python3
"""Generate public/openapi.json from docs/openapi.yaml.

Single source of truth: docs/openapi.yaml. The worker imports the generated
JSON (esbuild handles JSON imports) and serves it at /api/openapi.json.
Regenerate + commit both files whenever the spec changes.

Usage: python3 scripts/openapi-to-json.py
"""

import json
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    sys.exit("pyyaml is required (pip install pyyaml)")

ROOT = Path(__file__).resolve().parent.parent
spec = yaml.safe_load((ROOT / "docs" / "openapi.yaml").read_text())

out = ROOT / "public" / "openapi.json"
out.write_text(json.dumps(spec, indent=2, ensure_ascii=False) + "\n")
print(f"wrote {out} ({len(json.dumps(spec))} bytes of JSON)")
