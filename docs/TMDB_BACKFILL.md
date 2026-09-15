# TMDB poster backfill — deploy-time runbook

> One-time data operation that backfills `poster_url` / `backdrop_url` /
> `tmdb_id` on `screen_works` rows that lack posters. Deliberately a shell
> script, **not** an HTTP route — there is no `/admin/*` endpoint for
> enrichment and none will be built on the shared-secret curation gate.

## Safety properties (baked into the script)

- **Never overwrites a poster.** The SELECT only reads poster-less rows, and
  every generated `UPDATE` carries `WHERE … AND (poster_url IS NULL OR
  poster_url = '')` — a poster set manually between the read and the write
  always wins.
- **Idempotent.** Re-running enriches only rows that are still missing posters.
- **Rate-limited.** 300 ms between TMDB calls ≈ 33 req / 10 s, under the
  ~40 req / 10 s free-tier cap.
- **Fail-soft.** Titles with no TMDB match, API errors, and timeouts are
  counted (`failed`), not thrown — the batch continues.
- **No secrets in code.** The script takes `TMDB_API_KEY` from the operator's
  environment only. It never touches any admin route or owner secret.

## Prerequisites

1. `wrangler` logged in with access to the `novel-adaptations` Cloudflare
   account (same login that runs `wrangler deploy`).
2. `TMDB_API_KEY` in the operator's shell. Get the key from the Secure Vault /
   the owner — **never commit it, never paste it into chat or logs**.
3. Migration `0006_tmdb_enrichment.sql` (`backdrop_url` column) must be applied
   to the remote D1 — it runs automatically on `wrangler deploy`.

## Run instructions (exact commands)

Run from the repo root. Each block is copy-pasteable; the deploy agent must
confirm the summary JSON before treating a run as successful.

```sh
cd ~/workspace/novel-adaptations

# 1. Sanity check: how many rows need posters?
npx wrangler d1 execute novel-adaptations --remote \
  --command "SELECT COUNT(*) AS n FROM screen_works WHERE poster_url IS NULL OR poster_url = '';"

# 2. Dry run first — writes the SQL, touches nothing.
export TMDB_API_KEY="<paste key here; unset afterwards>"
node scripts/backfill-tmdb-posters.ts --dry-run

# 3. Review the generated file (out/tmdb-backfill-*.sql), then apply.
node scripts/backfill-tmdb-posters.ts
# → prints {"total":N,"enriched":N,"skipped":0,"failed":N}

# 4. Verify.
npx wrangler d1 execute novel-adaptations --remote \
  --command "SELECT COUNT(*) AS n FROM screen_works WHERE poster_url IS NULL OR poster_url = '';"

unset TMDB_API_KEY
```

Testing on a small batch first:

```sh
node scripts/backfill-tmdb-posters.ts --dry-run --limit 5
```

## Notes

- The script applies the SQL itself via `wrangler d1 execute --remote --file=…`
  unless `--dry-run` is passed. If you prefer a fully manual apply, run
  `--dry-run`, review the file, then:
  `npx wrangler d1 execute novel-adaptations --remote --file=out/tmdb-backfill-<stamp>.sql`
- TMDB attribution (required by their API terms) lives in the site footer
  (`src/ui.tsx`): "This product uses the TMDB API but is not endorsed or
  certified by TMDB." with a link to themoviedb.org.
- Ongoing enrichment (new screen works added by the news pipeline) is a future
  step; this backfill covers the existing catalog only.
