#!/usr/bin/env python3
"""Commit the working tree to GitHub master via the Git Data API only.

Never pushes over HTTPS, never force-pushes. Flow:
  1. GET the master ref (re-read remote HEAD first).
  2. Create a blob per changed/added file.
  3. Create a tree on top of the base tree (deletions via sha=null).
  4. Create a commit with the master SHA as parent.
  5. PATCH the ref to the new commit (fast-forward only — no `force`).

Usage: commit.py <repo-root> "<commit message>"
"""
import base64
import json
import os
import subprocess
import sys
import urllib.request

sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

CRED = "custom.github"
HOSTS = ["api.github.com"]
OWNER, REPO, BRANCH = "tannerwj", "novel-adaptations", "master"


def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"https://api.github.com{path}",
        data=data,
        method=method,
        headers={"Accept": "application/vnd.github+json", "User-Agent": "muse-github-skill"},
    )
    add_surrogate_to_request(req, CRED, allowed_hosts=HOSTS)
    with urllib.request.urlopen(req, timeout=60) as resp:
        return read_json_response(resp)


def git(*args, cwd):
    out = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=True).stdout
    return out[:-1] if out.endswith("\n") else out


def main():
    root, message = sys.argv[1], sys.argv[2]

    # 1. Re-read remote master.
    ref = api("GET", f"/repos/{OWNER}/{REPO}/git/refs/heads/{BRANCH}")
    base_sha = ref["object"]["sha"]
    print(f"remote {BRANCH} = {base_sha}", file=sys.stderr)
    local_base = git("rev-parse", "HEAD", cwd=root)
    if local_base != base_sha:
        print(f"ABORT: local HEAD {local_base} != remote {base_sha} (fetch/rebase first)", file=sys.stderr)
        sys.exit(1)

    base_commit = api("GET", f"/repos/{OWNER}/{REPO}/git/commits/{base_sha}")
    base_tree = base_commit["tree"]["sha"]

    # 2. Changed files from git status.
    status = git("status", "--porcelain", cwd=root).splitlines()
    entries = []
    for line in status:
        code, path = line[:2], line[3:]
        # Skip directories (e.g. ?? scripts/__pycache__/) — gitignore
        # should exclude them, but never blob a directory by accident.
        if path.endswith("/") or os.path.isdir(f"{root}/{path}"):
            print(f"  skip dir {path}", file=sys.stderr)
            continue
        if code.strip() == "D" or code == " D":
            entries.append({"path": path, "mode": "100644", "type": "blob", "sha": None})
            print(f"  delete {path}", file=sys.stderr)
            continue
        with open(f"{root}/{path}", "rb") as f:
            content = f.read()
        try:
            text = content.decode("utf-8")
            blob = api("POST", f"/repos/{OWNER}/{REPO}/git/blobs",
                       {"content": text, "encoding": "utf-8"})
        except UnicodeDecodeError:
            blob = api("POST", f"/repos/{OWNER}/{REPO}/git/blobs",
                       {"content": base64.b64encode(content).decode(), "encoding": "base64"})
        entries.append({"path": path, "mode": "100644", "type": "blob", "sha": blob["sha"]})
        print(f"  blob {path} ({len(content)} bytes)", file=sys.stderr)

    if not entries:
        print("nothing to commit", file=sys.stderr)
        return

    # 3. Tree on top of base.
    tree = api("POST", f"/repos/{OWNER}/{REPO}/git/trees",
               {"base_tree": base_tree, "tree": entries})
    print(f"tree {tree['sha']}", file=sys.stderr)

    # 4. Commit.
    commit = api("POST", f"/repos/{OWNER}/{REPO}/git/commits",
                 {"message": message, "tree": tree["sha"], "parents": [base_sha]})
    print(f"commit {commit['sha']}", file=sys.stderr)

    # 5. Fast-forward the ref (no force).
    api("PATCH", f"/repos/{OWNER}/{REPO}/git/refs/heads/{BRANCH}", {"sha": commit["sha"]})
    print(f"updated {BRANCH} -> {commit['sha']}")


if __name__ == "__main__":
    main()
