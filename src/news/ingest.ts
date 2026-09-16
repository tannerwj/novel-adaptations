/**
 * src/news/ingest.ts — autonomous news ingestion (Phase 3).
 *
 * Merged from the /tmp/news-pipe prototype. Scheduled daily at 06:00 UTC
 * ("0 6 * * *" in wrangler.toml). Dependency-free: hand-rolled RSS 2.0/Atom
 * parsing, Web Crypto for URL hashing.
 *
 * Per run:
 *  0. Auto-dismiss SLA: pending items older than 30 days are dismissed.
 *  1. Fetch all 8 feeds in parallel (15s timeout each; one failure never
 *     kills the run). Feed health is recorded in the `sources` table.
 *  2. Parse → normalize → dedupe (sha256 of canonical URL; UNIQUE in D1).
 *  3. Keyword pre-filter gates which items reach the LLM.
 *  4. Classify with Workers AI (Llama 4 Scout) through the
 *     "novel-adaptations" AI Gateway. If the LLM is unavailable, fall back
 *     to keyword heuristics and flag needs_review=1.
 *  5. Insert pending items into D1 `news_items` for owner curation.
 *     Items failing the keyword pre-filter are recorded as `dismissed`
 *     (non-adaptation noise), never queued, and never counted against the
 *     pending quarantine cap.
 *
 * Feed content is untrusted third-party text: it only ever goes into the
 * LLM's *user* message, output is schema-validated, and extracted strings
 * are stored as data (HTML-escaped on render). No feed content ever becomes
 * an instruction to the worker.
 *
 * CAUTION GUARDRAILS (Track A):
 * - Kill switch: `PIPELINE_ENABLED` must be exactly "1" or the run is
 *   recorded as 'disabled' and does nothing else (fail closed).
 * - At most 25 LLM calls per run; overflow falls back to keyword heuristics
 *   and is flagged needs_review=1.
 * - At most 40 new `pending` rows per run; extras are skipped (never
 *   queued) and counted as items_skipped_cap.
 * - Any classification with confidence < 0.6 is flagged needs_review=1.
 * - Every run (ran/disabled/error) writes a row to `pipeline_runs`.
 * This module never publishes, never changes adaptation statuses, never
 * sends anything — it only writes `pending` rows (plus `dismissed` prefilter
 * noise) for owner curation.
 */

import {
  CRON_BATCH_SIZE,
  runEnrichmentBatch,
} from '../enrichment';
import { keywordGate, prefilterDisposition } from './gate';

export interface NewsEnv {
  DB: D1Database;
  /** Present in production; may be absent in local dev — code degrades. */
  AI?: Ai;
  /**
   * Kill switch. The scheduled run does nothing unless this is exactly "1".
   * Coordinator must add `PIPELINE_ENABLED?: string` to `Env` in src/index.tsx.
   */
  PIPELINE_ENABLED?: string;
  /**
   * TMDB API key (worker secret). Feeds the enrichment backstop only; when
   * absent, enrichment calls are graceful no-ops and the news run continues.
   */
  TMDB_API_KEY?: string;
}

interface Source {
  name: string;
  feed_url: string;
  trust_tier: 'trusted' | 'reputable' | 'rumor';
}

/** Owner default: all 8 feeds (see docs/NEWS_PIPELINE.md §2). */
export const SOURCES: Source[] = [
  { name: 'Deadline', feed_url: 'https://deadline.com/feed/', trust_tier: 'trusted' },
  { name: 'Variety', feed_url: 'https://variety.com/feed/', trust_tier: 'trusted' },
  { name: 'The Hollywood Reporter', feed_url: 'https://www.hollywoodreporter.com/feed/', trust_tier: 'trusted' },
  { name: 'Collider', feed_url: 'https://collider.com/feed/', trust_tier: 'reputable' },
  { name: 'ScreenRant', feed_url: 'https://screenrant.com/feed/', trust_tier: 'reputable' },
  { name: 'BookRiot', feed_url: 'https://bookriot.com/feed/', trust_tier: 'reputable' },
  { name: '/Film', feed_url: 'https://www.slashfilm.com/feed/', trust_tier: 'reputable' },
  { name: 'Flickering Myth', feed_url: 'https://www.flickeringmyth.com/feed/', trust_tier: 'rumor' },
];

const SYSTEM_PROMPT = `You are a classifier for Novel Adaptations, a tracker of books adapted into films and TV series. Given a news headline and summary, decide whether it is about a book being adapted for the screen.

Respond with ONLY a JSON object:
{"is_adaptation_news": true|false, "book_title": "title or null", "author": "author or null", "screen_kind": "film"|"series"|"unknown", "status_signal": "rumored"|"optioned"|"in_development"|"filming"|"post_production"|"released"|"none", "confidence": 0.0-1.0, "reason": "one short sentence"}

Rules:
- "based on the novel", "adaptation of", "optioned the rights" -> is_adaptation_news true.
- Casting/sequel news for an existing adaptation -> true, status_signal from context.
- Book reviews, author interviews, box-office reports with no adaptation angle -> false.
- status_signal "rumored" only when the text hedges ("in talks", "eyed", "reportedly", "could").
- confidence < 0.5 stays pending but sorts to the bottom of the curation queue.`;

const MAX_LLM_CALLS_PER_RUN = 25;
/** Quarantine cap: at most this many new `pending` rows per run. */
const MAX_PENDING_INSERTS_PER_RUN = 40;
/** Classifications below this confidence are flagged needs_review=1. */
const CONFIDENCE_REVIEW_THRESHOLD = 0.6;
const GATEWAY_ID = 'novel-adaptations';
const MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';
/** Spec §8: pending items older than this are auto-dismissed each run. */
const PENDING_SLA_DAYS = 30;

interface FeedItem {
  title: string;
  url: string;
  summary: string;
  published_at: string | null;
}

// --- tiny RSS 2.0 / Atom parser (no dependencies) ---

function extractTag(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!m) return '';
  return decodeXmlEntities(stripCdata(m[1] ?? '').trim());
}

/**
 * Decode the XML entities feeds actually emit. `&amp;` decodes last so
 * `&amp;lt;` becomes `&lt;`, not `<`. Without this, URLs containing
 * `&amp;` (e.g. `?utm_source=x&amp;utm_medium=rss`) canonicalize wrong
 * and the URL-hash dedupe misses.
 */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseFeed(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  // RSS 2.0
  const rssBlocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  for (const b of rssBlocks) {
    const link = extractTag(b, 'link') || extractTag(b, 'guid');
    if (!link) continue;
    items.push({
      title: stripHtml(extractTag(b, 'title')),
      url: link.trim(),
      summary: stripHtml(extractTag(b, 'description')).slice(0, 1000),
      published_at: extractTag(b, 'pubDate') || null,
    });
  }
  // Atom
  if (items.length === 0) {
    const entryBlocks = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
    for (const b of entryBlocks) {
      const linkM = b.match(/<link[^>]*href="([^"]+)"/i);
      const link = linkM?.[1] ?? '';
      if (!link) continue;
      items.push({
        title: stripHtml(extractTag(b, 'title')),
        url: link.trim(),
        summary: stripHtml(extractTag(b, 'summary') || extractTag(b, 'content')).slice(0, 1000),
        published_at: extractTag(b, 'published') || extractTag(b, 'updated') || null,
      });
    }
  }
  return items;
}

// --- helpers ---

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_)/i.test(p)) u.searchParams.delete(p);
    }
    return u.toString();
  } catch {
    return url;
  }
}

/** Spec §4.1 secondary dedupe: same story re-posted under a new URL. */
function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function heuristicScore(text: string): number {
  const t = text.toLowerCase();
  let score = 0;
  for (const p of ['based on the novel', 'based on the book', 'adaptation of']) if (t.includes(p)) score += 2;
  for (const p of ['optioned', 'film rights', 'tv rights', 'in development', 'casting', 'to direct', 'showrunner', 'limited series']) if (t.includes(p)) score += 1;
  for (const p of ['review:', 'interview', 'box office']) if (t.includes(p)) score -= 2;
  return score;
}

interface Classification {
  is_adaptation_news: boolean;
  book_title: string | null;
  author: string | null;
  screen_kind: string;
  status_signal: string;
  confidence: number;
  reason: string;
}

function validateClassification(raw: unknown): Classification | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.is_adaptation_news !== 'boolean') return null;
  const conf = typeof o.confidence === 'number' ? Math.min(1, Math.max(0, o.confidence)) : 0;
  const kinds = ['film', 'series', 'unknown'];
  const signals = ['rumored', 'optioned', 'in_development', 'filming', 'post_production', 'released', 'none'];
  return {
    is_adaptation_news: o.is_adaptation_news,
    book_title: typeof o.book_title === 'string' ? o.book_title.slice(0, 300) : null,
    author: typeof o.author === 'string' ? o.author.slice(0, 300) : null,
    screen_kind: kinds.includes(o.screen_kind as string) ? (o.screen_kind as string) : 'unknown',
    status_signal: signals.includes(o.status_signal as string) ? (o.status_signal as string) : 'none',
    confidence: conf,
    reason: typeof o.reason === 'string' ? o.reason.slice(0, 500) : '',
  };
}

async function classifyWithLLM(
  env: NewsEnv,
  title: string,
  summary: string,
): Promise<{ c: Classification | null; failed: boolean }> {
  try {
    if (!env.AI) throw new Error('AI binding unavailable');
    const res = (await env.AI.run(
      MODEL,
      {
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `TITLE: ${title}\nSUMMARY: ${summary}` },
        ],
        max_tokens: 300,
        temperature: 0,
      },
      { gateway: { id: GATEWAY_ID, skipCache: false } },
    )) as { response?: string };
    const text = (res.response ?? '').trim().replace(/^```json?\s*|\s*```$/g, '');
    return { c: validateClassification(JSON.parse(text)), failed: false };
  } catch (e) {
    console.error('LLM classification failed, using heuristics:', (e as Error).message);
    return { c: null, failed: true };
  }
}

/**
 * One row of the `pipeline_runs` observability table (migrations/0004).
 * Defined here (not src/db.ts) — Track A owns this surface.
 */
export interface PipelineRun {
  id: number;
  started_at: string;
  finished_at: string | null;
  status: 'ran' | 'disabled' | 'error';
  feeds_ok: number;
  feeds_failed: number;
  items_fetched: number;
  items_new: number;
  items_skipped_cap: number;
  llm_calls: number;
  errors: string | null;
  created_at: string;
}

type PipelineRunInsert = Omit<PipelineRun, 'id' | 'created_at'>;

/** Write a completed/disabled/failed run to `pipeline_runs`. */
async function recordPipelineRun(
  db: D1Database,
  run: PipelineRunInsert,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO pipeline_runs
         (started_at, finished_at, status, feeds_ok, feeds_failed,
          items_fetched, items_new, items_skipped_cap, llm_calls, errors)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      run.started_at,
      run.finished_at,
      run.status,
      run.feeds_ok,
      run.feeds_failed,
      run.items_fetched,
      run.items_new,
      run.items_skipped_cap,
      run.llm_calls,
      run.errors,
    )
    .run();
}

/** Newest-first listing for the owner-visible "Pipeline runs" admin view. */
export async function listPipelineRuns(
  db: D1Database,
  limit: number,
): Promise<PipelineRun[]> {
  const rows = await db
    .prepare(`SELECT * FROM pipeline_runs ORDER BY id DESC LIMIT ?`)
    .bind(Math.max(1, Math.min(200, limit)))
    .all<PipelineRun>();
  return rows.results ?? [];
}

/**
 * The scheduled entry point, wired into src/index.tsx's default export.
 * Idempotent: re-running the same day inserts nothing new.
 */
export async function scheduledNewsRun(env: NewsEnv): Promise<void> {
  // KILL SWITCH — fail closed. Unset or any value other than "1" records a
  // 'disabled' run and does nothing else.
  const startedAt = new Date().toISOString();
  if (env.PIPELINE_ENABLED !== '1') {
    await recordPipelineRun(env.DB, {
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      status: 'disabled',
      feeds_ok: 0,
      feeds_failed: 0,
      items_fetched: 0,
      items_new: 0,
      items_skipped_cap: 0,
      llm_calls: 0,
      errors: 'PIPELINE_ENABLED is not "1" (kill switch engaged)',
    });
    console.log('news run disabled: PIPELINE_ENABLED is not "1"');
    return;
  }

  const stats = {
    feeds_ok: 0,
    feeds_failed: 0,
    items_fetched: 0,
    items_new: 0,
    items_skipped_cap: 0,
    items_dismissed_prefilter: 0,
    llm_calls: 0,
  };

  try {
    await runIngestion(env, stats);
    await recordPipelineRun(env.DB, {
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      status: 'ran',
      errors: null,
      ...stats,
    });
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    await recordPipelineRun(env.DB, {
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      status: 'error',
      errors: msg.slice(0, 2000),
      ...stats,
    });
    throw e; // rethrow so the cron run still surfaces as failed
  }

  // Track 5 (Round 3) backstop: drain up to CRON_BATCH_SIZE flagged or
  // poster-less screen works through TMDB enrichment. The primary path is
  // the owner-driven POST /admin/backfill/tmdb endpoint (src/enrichment.ts);
  // this keeps the backlog draining on its own. Never breaks the news run:
  // sweepEnrichment is itself failure-proof, and this belt-and-braces
  // try/catch covers anything above it.
  try {
    const sw = await sweepEnrichment(env);
    console.log(
      `enrichment sweep: ${sw.done} attempted, ${sw.enriched} enriched, ${sw.failed} failed`,
    );
  } catch (e) {
    console.error(
      'enrichment sweep threw (news run unaffected):',
      (e as Error).message,
    );
  }
}

/**
 * The Track 5 (Round 3) backstop: enrich up to CRON_BATCH_SIZE rows that are
 * flagged (needs_enrichment = 1) or still poster-less, via the same core the
 * POST /admin/backfill/tmdb endpoint uses. Never throws.
 */
export async function sweepEnrichment(
  env: NewsEnv,
): Promise<{ done: number; enriched: number; failed: number }> {
  try {
    return await runEnrichmentBatch(
      { DB: env.DB, TMDB_API_KEY: env.TMDB_API_KEY },
      CRON_BATCH_SIZE,
    );
  } catch (e) {
    console.error('enrichment sweep failed:', (e as Error).message);
    return { done: 0, enriched: 0, failed: 0 };
  }
}

/**
 * The actual ingestion work. `stats` is mutated in place so the caller can
 * record the run even if this throws partway through.
 */
async function runIngestion(
  env: NewsEnv,
  stats: {
    feeds_ok: number;
    feeds_failed: number;
    items_fetched: number;
    items_new: number;
    items_skipped_cap: number;
    items_dismissed_prefilter: number;
    llm_calls: number;
  },
): Promise<void> {
  // Step 0 — SLA: auto-dismiss pending items older than 30 days (spec §8).
  const sla = await env.DB.prepare(
    `UPDATE news_items SET status = 'dismissed', dismiss_reason = 'auto-dismissed: pending > 30 days'
     WHERE status = 'pending' AND created_at < datetime('now', ?1)`,
  )
    .bind(`-${PENDING_SLA_DAYS} days`)
    .run();
  if ((sla.meta?.changes ?? 0) > 0) {
    console.log(`SLA auto-dismissed ${sla.meta.changes} stale pending items`);
  }

  // Secondary dedupe (spec §4.1): normalized titles seen in the last 7 days.
  const recentRows = await env.DB.prepare(
    `SELECT title FROM news_items WHERE created_at > datetime('now', '-7 days')`,
  ).all<{ title: string }>();
  const recentTitles = new Set((recentRows.results ?? []).map((r) => normalizeTitle(r.title)));

  const results = await Promise.allSettled(
    SOURCES.map(async (src) => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      try {
        const resp = await fetch(src.feed_url, {
          signal: ctrl.signal,
          headers: { 'User-Agent': 'NovelAdaptationsBot/1.0 (+https://noveladaptations.com)' },
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const xml = await resp.text();
        const items = parseFeed(xml);
        await env.DB.prepare(
          `INSERT INTO sources (name, feed_url, trust_tier, last_fetched_at, last_status, consecutive_failures)
           VALUES (?, ?, ?, datetime('now'), 'ok', 0)
           ON CONFLICT(name) DO UPDATE SET last_fetched_at=datetime('now'), last_status='ok', consecutive_failures=0`,
        )
          .bind(src.name, src.feed_url, src.trust_tier)
          .run();
        return { src, items, ok: true };
      } catch (e) {
        await env.DB.prepare(
          `INSERT INTO sources (name, feed_url, trust_tier, last_status, consecutive_failures)
           VALUES (?, ?, ?, 'error', 1)
           ON CONFLICT(name) DO UPDATE SET last_status='error',
             consecutive_failures = consecutive_failures + 1,
             is_active = CASE WHEN consecutive_failures + 1 >= 5 THEN 0 ELSE is_active END`,
        )
          .bind(src.name, src.feed_url, src.trust_tier)
          .run();
        console.error(`Feed failed: ${src.name}:`, (e as Error).message);
        return { src, items: [] as FeedItem[], ok: false };
      } finally {
        clearTimeout(t);
      }
    }),
  );

  for (const r of results) {
    if (r.status !== 'fulfilled') {
      stats.feeds_failed++;
      continue;
    }
    const { src, items, ok } = r.value;
    if (ok) stats.feeds_ok++;
    else stats.feeds_failed++;
    stats.items_fetched += items.length;
    for (const item of items) {
      if (!item.title || !item.url) continue;
      const url = canonicalUrl(item.url);
      const urlHash = await sha256Hex(url);
      const seen = await env.DB.prepare('SELECT 1 FROM news_items WHERE url_hash = ?').bind(urlHash).first();
      if (seen) continue; // dedupe: primary key is the URL hash
      const titleNorm = normalizeTitle(item.title);
      if (recentTitles.has(titleNorm)) continue; // dedupe: same title, new URL

      // QUARANTINE CAP: applies to pending candidates only. Below-gate
      // items are dismissed outright and never consume cap.
      const text = `${item.title} ${item.summary}`;
      const passesGate = keywordGate(text);
      if (passesGate && stats.items_new >= MAX_PENDING_INSERTS_PER_RUN) {
        stats.items_skipped_cap++;
        continue;
      }
      const disposition = prefilterDisposition(passesGate);

      let cls: Classification;
      let llmModel = 'none';
      let needsReview = 0;

      if (passesGate && stats.llm_calls < MAX_LLM_CALLS_PER_RUN) {
        stats.llm_calls++;
        const { c, failed } = await classifyWithLLM(env, item.title, item.summary);
        if (!failed && c) {
          cls = c;
          llmModel = MODEL;
        } else {
          // Fallback: keyword heuristics
          const s = heuristicScore(text);
          cls = {
            is_adaptation_news: s >= 2,
            book_title: null,
            author: null,
            screen_kind: 'unknown',
            status_signal: 'none',
            confidence: 0.3,
            reason: 'heuristic fallback (LLM unavailable)',
          };
          llmModel = 'heuristic';
          needsReview = 1;
        }
      } else if (passesGate) {
        // Over the per-run LLM cap: keyword heuristics instead of inference,
        // flagged for owner review.
        const s = heuristicScore(text);
        cls = {
          is_adaptation_news: s >= 2,
          book_title: null,
          author: null,
          screen_kind: 'unknown',
          status_signal: 'none',
          confidence: 0.3,
          reason: 'heuristic fallback (per-run LLM cap reached)',
        };
        llmModel = 'heuristic';
        needsReview = 1;
      } else {
        // Below the keyword gate: record as non-adaptation without spending
        // inference.
        cls = {
          is_adaptation_news: false,
          book_title: null,
          author: null,
          screen_kind: 'unknown',
          status_signal: 'none',
          confidence: 0.9,
          reason: 'below keyword gate',
        };
        llmModel = 'prefilter';
      }

      // CONFIDENCE GATING: low-confidence classifications need owner review.
      if (cls.confidence < CONFIDENCE_REVIEW_THRESHOLD) needsReview = 1;

      await env.DB.prepare(
        `INSERT OR IGNORE INTO news_items
           (url, url_hash, title, summary, source, trust_tier, published_at,
            status, dismiss_reason, is_adaptation_news, book_title, author, screen_kind,
            status_signal, confidence, llm_model, needs_review)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          url,
          urlHash,
          item.title.slice(0, 500),
          item.summary,
          src.name,
          src.trust_tier,
          item.published_at,
          disposition.status,
          disposition.dismiss_reason,
          cls.is_adaptation_news ? 1 : 0,
          cls.book_title,
          cls.author,
          cls.screen_kind,
          cls.status_signal,
          cls.confidence,
          llmModel,
          needsReview,
        )
        .run();
      recentTitles.add(titleNorm);
      if (passesGate) stats.items_new++;
      else stats.items_dismissed_prefilter++;
    }
  }

  console.log(
    `news run complete: ${stats.items_new} pending inserted, ${stats.items_dismissed_prefilter} dismissed (below gate), ${stats.items_skipped_cap} skipped (cap), ${stats.llm_calls} LLM calls, ${stats.feeds_ok} feeds ok / ${stats.feeds_failed} failed`,
  );
}
