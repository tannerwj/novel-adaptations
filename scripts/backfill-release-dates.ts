#!/usr/bin/env node
/**
 * scripts/backfill-release-dates.ts — one-time TMDB release-date backfill.
 *
 * This is a DEPLOY-TIME DATA OPERATION, not an HTTP route. There is
 * deliberately no /admin/* route for this: enrichment runs from an operator's
 * shell with a real TMDB key and is fully reviewable before anything is
 * written to D1. (Interactive single-row edits live at /admin/screen-works.)
 *
 * What it does:
 *   1. Reads every screen_works row with a tmdb_id but no release_date from
 *      the REMOTE D1 (via `wrangler d1 execute --remote`).
 *   2. Fetches the work directly from TMDB (`/movie/{id}` or `/tv/{id}`,
 *      same rate-limit respect as everywhere else: 300ms between calls).
 *   3. Takes `release_date` (film) / `first_air_date` (series), strictly
 *      validated as YYYY-MM-DD.
 *   4. Writes idempotent UPDATE statements to a timestamped .sql file.
 *   5. Applies them with `wrangler d1 execute --remote --file=…` (skipped
 *      with --dry-run).
 *
 * Guarantees:
 *   - NEVER overwrites an existing release_date. The SELECT only reads
 *     undated rows AND every UPDATE carries
 *     `WHERE … AND release_date IS NULL`, so a manual date set between the
 *     read and the write always wins.
 *   - Idempotent: re-running only touches rows that are still undated.
 *   - Failures are counted, never fatal: a missing TMDB entry / API error /
 *     unparseable date increments `failed` and the batch continues.
 *
 * Usage:
 *   export TMDB_API_KEY="<key>"        # operator shell only — never committed
 *   node scripts/backfill-release-dates.ts --dry-run     # writes SQL, does not apply
 *   node scripts/backfill-release-dates.ts               # writes SQL and applies it
 *   node scripts/backfill-release-dates.ts --limit 5     # test with a small batch
 *
 * Requires Node 22.6+ (native .ts import stripping) and `wrangler` logged in.
 */

import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const D1_DATABASE = process.env.D1_DATABASE ?? 'novel-adaptations';
const RATE_LIMIT_MS = 300;

interface DatelessWork {
  id: number;
  title: string;
  kind: string;
  tmdb_id: number;
}

function usage(): never {
  console.error(`Usage: node scripts/backfill-release-dates.ts [--dry-run] [--limit N] [--db NAME]

Options:
  --dry-run   Write the SQL file but do NOT apply it to D1.
  --limit N   Only process the first N dateless rows (for testing).
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
function extractRows(json: string): DatelessWork[] {
  const parsed: unknown = JSON.parse(json);
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  for (const item of arr) {
    if (item && typeof item === 'object' && Array.isArray((item as { results?: unknown }).results)) {
      return (item as { results: DatelessWork[] }).results;
    }
  }
  throw new Error('unexpected wrangler d1 execute --json shape (no .results)');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** SQL-escape a string literal: only single-quote doubling is needed. */
function sqlLit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * Strict YYYY-MM-DD validation: format plus a real calendar date. TMDB
 * occasionally returns '' or impossible dates; those are skipped, never
 * written.
 */
function cleanTmdbDate(raw: unknown): string | null {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) return null;
  const date = raw.trim();
  const [ys, ms, ds] = date.split('-');
  const y = Number(ys);
  const m = Number(ms);
  const d = Number(ds);
  const roundTrip = new Date(Date.UTC(y, m - 1, d));
  if (
    roundTrip.getUTCFullYear() !== y ||
    roundTrip.getUTCMonth() !== m - 1 ||
    roundTrip.getUTCDate() !== d
  ) {
    return null;
  }
  return date;
}

/** Fetch /movie/{id} or /tv/{id} and return its release_date / first_air_date. */
async function fetchTmdbReleaseDate(
  apiKey: string,
  work: DatelessWork,
): Promise<string | null> {
  const endpoint = work.kind === 'series' ? 'tv' : 'movie';
  const url = `https://api.themoviedb.org/3/${endpoint}/${work.tmdb_id}?api_key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (res.status === 404) return null; // TMDB id stale — count as failed, move on
  if (!res.ok) throw new Error(`TMDB ${res.status} for ${endpoint}/${work.tmdb_id}`);
  const body: unknown = await res.json();
  if (!body || typeof body !== 'object') return null;
  const rec = body as Record<string, unknown>;
  return cleanTmdbDate(rec[work.kind === 'series' ? 'first_air_date' : 'release_date']);
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
    `SELECT id, title, kind, tmdb_id FROM screen_works WHERE tmdb_id IS NOT NULL AND release_date IS NULL ORDER BY id ASC${limit ? ` LIMIT ${limit}` : ''}`,
  ]);
  const works = extractRows(raw);

  const summary = { total: works.length, dated: 0, skipped: 0, failed: 0 };
  const statements: string[] = [
    `-- TMDB release-date backfill, generated ${new Date().toISOString()}`,
    `-- Idempotent: each UPDATE only touches rows still missing a release_date.`,
    `-- Never overwrites an existing (manually-set) release_date.`,
  ];

  for (const work of works) {
    try {
      const releaseDate = await fetchTmdbReleaseDate(apiKey, work);
      if (!releaseDate) {
        summary.skipped += 1;
        console.error(`  - ${work.title}: no usable TMDB date, skipped`);
      } else {
        // The WHERE guard repeats the dateless condition so this is a true
        // no-op if a date was set after the SELECT (manual dates win).
        statements.push(
          `UPDATE screen_works SET release_date = ${sqlLit(releaseDate)} WHERE id = ${work.id} AND release_date IS NULL; -- ${work.title.replace(/\n/g, ' ')}`,
        );
        summary.dated += 1;
      }
    } catch (err) {
      summary.failed += 1;
      console.error(`  ! ${work.title}: ${(err as Error).message}`);
    }
    await sleep(RATE_LIMIT_MS);
  }

  const outDir = resolve(REPO_ROOT, 'out');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = resolve(outDir, `release-dates-${stamp}.sql`);
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
