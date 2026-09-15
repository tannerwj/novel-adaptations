#!/usr/bin/env node
/**
 * scripts/backfill-tmdb-posters.ts — one-time TMDB poster backfill.
 *
 * This is a DEPLOY-TIME DATA OPERATION, not an HTTP route. There is
 * deliberately no /admin/* route for this: enrichment runs from an operator's
 * shell with a real TMDB key and is fully reviewable before anything is
 * written to D1.
 *
 * What it does:
 *   1. Reads every screen_works row missing a poster_url from the REMOTE D1
 *      (via `wrangler d1 execute --remote`).
 *   2. Looks each title up on TMDB (src/tmdb.ts, same rate-limit respect as
 *      everywhere else: 300ms between calls ≈ 33 req/10s, under the ~40/10s
 *      free-tier cap).
 *   3. Writes idempotent UPDATE statements to a timestamped .sql file.
 *   4. Applies them with `wrangler d1 execute --remote --file=…` (skipped with
 *      --dry-run).
 *
 * Guarantees:
 *   - NEVER overwrites an existing poster_url. The SELECT only reads
 *     poster-less rows AND every UPDATE carries
 *     `WHERE … AND (poster_url IS NULL OR poster_url = '')`, so a manual
 *     poster set between the read and the write always wins.
 *   - Idempotent: re-running only touches rows that are still missing posters.
 *   - Failures are counted, never fatal: a bad title / API error / timeout
 *     increments `failed` and the batch continues.
 *
 * Usage (see docs/TMDB_BACKFILL.md for the full runbook):
 *   export TMDB_API_KEY="<key>"        # operator shell only — never committed
 *   node scripts/backfill-tmdb-posters.ts --dry-run     # writes SQL, does not apply
 *   node scripts/backfill-tmdb-posters.ts               # writes SQL and applies it
 *   node scripts/backfill-tmdb-posters.ts --limit 5     # test with a small batch
 *
 * Requires Node 22.6+ (native .ts import stripping) and `wrangler` logged in.
 */

import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// src/tmdb.ts is erasable-syntax-only TS, so Node's type stripping can import
// it directly. No network happens without a key — see the module's header.
import { enrichScreenWork } from '../src/tmdb.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const D1_DATABASE = process.env.D1_DATABASE ?? 'novel-adaptations';
const RATE_LIMIT_MS = 300;

interface PosterlessWork {
  id: number;
  title: string;
  kind: string;
  release_date: string | null;
}

function usage(): never {
  console.error(`Usage: node scripts/backfill-tmdb-posters.ts [--dry-run] [--limit N] [--db NAME]

Options:
  --dry-run   Write the SQL file but do NOT apply it to D1.
  --limit N   Only process the first N poster-less rows (for testing).
  --db NAME   D1 database name (default: novel-adaptations; env D1_DATABASE).

Required env: TMDB_API_KEY (operator's shell — never commit it).`);
  process.exit(1);
}

function parseArgs(argv: string[]): { dryRun: boolean; limit: number | null; db: string } {
  const out = { dryRun: false, limit: null as number | null, db: D1_DATABASE };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--limit') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n <= 0) usage();
      out.limit = n;
    } else if (a === '--db') {
      out.db = argv[++i] ?? '';
      if (!out.db) usage();
    } else usage();
  }
  return out;
}

function runWrangler(args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'wrangler',
      args,
      { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(`wrangler ${args.join(' ')} failed: ${(stderr || err.message).trim()}`),
          );
        } else {
          resolvePromise(stdout);
        }
      },
    );
  });
}

/** `wrangler d1 execute --json` returns an array of { results, meta, … }. */
function extractRows(json: string): PosterlessWork[] {
  const parsed: unknown = JSON.parse(json);
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  for (const item of arr) {
    if (item && typeof item === 'object' && Array.isArray((item as { results?: unknown }).results)) {
      return (item as { results: PosterlessWork[] }).results;
    }
  }
  throw new Error('unexpected wrangler d1 execute --json shape (no .results)');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** SQL-escape a string literal: only single-quote doubling is needed. */
function sqlLit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

async function main(): Promise<void> {
  const { dryRun, limit, db } = parseArgs(process.argv.slice(2));

  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) {
    console.error('ERROR: TMDB_API_KEY is not set in this shell. Aborting — no-op by design.');
    process.exit(1);
  }

  const raw = await runWrangler([
    'd1',
    'execute',
    db,
    '--remote',
    '--json',
    '--command',
    `SELECT id, title, kind, release_date FROM screen_works WHERE poster_url IS NULL OR poster_url = '' ORDER BY id ASC${limit ? ` LIMIT ${limit}` : ''}`,
  ]);
  const works = extractRows(raw);

  const summary = { total: works.length, enriched: 0, skipped: 0, failed: 0 };
  const statements: string[] = [
    `-- TMDB poster backfill, generated ${new Date().toISOString()}`,
    `-- Idempotent: each UPDATE only touches rows still missing a poster_url.`,
    `-- Never overwrites an existing (manually-set) poster_url.`,
  ];

  for (const work of works) {
    try {
      const year =
        work.release_date && /^\d{4}/.test(work.release_date)
          ? Number(work.release_date.slice(0, 4))
          : null;
      const result = await enrichScreenWork(
        apiKey,
        {
          title: work.title,
          kind: work.kind === 'series' ? 'series' : 'film',
          year,
        },
        fetch,
      );
      if (!result) {
        summary.failed += 1;
        continue;
      }
      // The WHERE guard repeats the poster-less condition so this is a true
      // no-op if a poster was set after the SELECT (manual posters win).
      statements.push(
        `UPDATE screen_works SET poster_url = ${sqlLit(result.posterUrl)}, backdrop_url = ${result.backdropUrl ? sqlLit(result.backdropUrl) : 'NULL'}, tmdb_id = ${result.tmdbId} WHERE id = ${work.id} AND (poster_url IS NULL OR poster_url = ''); -- ${work.title.replace(/\n/g, ' ')}`,
      );
      summary.enriched += 1;
    } catch (err) {
      summary.failed += 1;
      console.error(`  ! ${work.title}: ${(err as Error).message}`);
    }
    await sleep(RATE_LIMIT_MS);
  }

  const outDir = resolve(REPO_ROOT, 'out');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = resolve(outDir, `tmdb-backfill-${stamp}.sql`);
  writeFileSync(outFile, statements.join('\n') + '\n');
  console.error(`Wrote ${statements.length - 3} UPDATE statement(s) to ${outFile}`);

  if (dryRun) {
    console.error('Dry run: NOT applied. To apply, run without --dry-run.');
  } else {
    const applyOut = await runWrangler(['d1', 'execute', db, '--remote', `--file=${outFile}`]);
    console.error(applyOut.trim());
  }

  console.log(JSON.stringify(summary));
}

main().catch((err) => {
  console.error(`FATAL: ${(err as Error).message}`);
  process.exit(1);
});
