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
 *  4. Classify with Workers AI (Llama 3.1 8B Instruct) through the
 *     "novel-adaptations" AI Gateway. If the LLM is unavailable, fall back
 *     to keyword heuristics and flag needs_review=1.
 *  5. Insert pending items into D1 `news_items` for owner curation.
 *
 * Feed content is untrusted third-party text: it only ever goes into the
 * LLM's *user* message, output is schema-validated, and extracted strings
 * are stored as data (HTML-escaped on render). No feed content ever becomes
 * an instruction to the worker.
 */

export interface NewsEnv {
  DB: D1Database;
  /** Present in production; may be absent in local dev — code degrades. */
  AI?: Ai;
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

const ADAPTATION_TERMS = ['novel', 'book', 'adaptation', 'based on', 'optioned', 'rights', 'author'];
const SCREEN_TERMS = ['film', 'movie', 'series', 'show', 'tv', 'netflix', 'hulu', 'apple tv', 'casting', 'director', 'streaming'];

const SYSTEM_PROMPT = `You are a classifier for Novel Adaptations, a tracker of books adapted into films and TV series. Given a news headline and summary, decide whether it is about a book being adapted for the screen.

Respond with ONLY a JSON object:
{"is_adaptation_news": true|false, "book_title": "title or null", "author": "author or null", "screen_kind": "film"|"series"|"unknown", "status_signal": "rumored"|"optioned"|"in_development"|"filming"|"post_production"|"released"|"none", "confidence": 0.0-1.0, "reason": "one short sentence"}

Rules:
- "based on the novel", "adaptation of", "optioned the rights" -> is_adaptation_news true.
- Casting/sequel news for an existing adaptation -> true, status_signal from context.
- Book reviews, author interviews, box-office reports with no adaptation angle -> false.
- status_signal "rumored" only when the text hedges ("in talks", "eyed", "reportedly", "could").
- confidence < 0.5 stays pending but sorts to the bottom of the curation queue.`;

const MAX_LLM_CALLS_PER_RUN = 100;
const GATEWAY_ID = 'novel-adaptations';
const MODEL = '@cf/meta/llama-3.1-8b-instruct';
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

function keywordGate(text: string): boolean {
  const t = text.toLowerCase();
  return ADAPTATION_TERMS.some((w) => t.includes(w)) && SCREEN_TERMS.some((w) => t.includes(w));
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
 * The scheduled entry point, wired into src/index.tsx's default export.
 * Idempotent: re-running the same day inserts nothing new.
 */
export async function scheduledNewsRun(env: NewsEnv): Promise<void> {
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

  let llmCalls = 0;
  let inserted = 0;

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
        return { src, items };
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
        return { src, items: [] as FeedItem[] };
      } finally {
        clearTimeout(t);
      }
    }),
  );

  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    const { src, items } = r.value;
    for (const item of items) {
      if (!item.title || !item.url) continue;
      const url = canonicalUrl(item.url);
      const urlHash = await sha256Hex(url);
      const seen = await env.DB.prepare('SELECT 1 FROM news_items WHERE url_hash = ?').bind(urlHash).first();
      if (seen) continue; // dedupe: primary key is the URL hash
      const titleNorm = normalizeTitle(item.title);
      if (recentTitles.has(titleNorm)) continue; // dedupe: same title, new URL

      const text = `${item.title} ${item.summary}`;
      const passesGate = keywordGate(text);

      let cls: Classification;
      let llmModel = 'none';
      let needsReview = 0;

      if (passesGate && llmCalls < MAX_LLM_CALLS_PER_RUN) {
        llmCalls++;
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
      } else {
        // Below the keyword gate (or over the per-run LLM cap): record as
        // non-adaptation without spending inference.
        cls = {
          is_adaptation_news: false,
          book_title: null,
          author: null,
          screen_kind: 'unknown',
          status_signal: 'none',
          confidence: 0.9,
          reason: passesGate ? 'deferred: per-run LLM cap reached' : 'below keyword gate',
        };
        llmModel = 'prefilter';
      }

      await env.DB.prepare(
        `INSERT OR IGNORE INTO news_items
           (url, url_hash, title, summary, source, trust_tier, published_at,
            status, is_adaptation_news, book_title, author, screen_kind,
            status_signal, confidence, llm_model, needs_review)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          url,
          urlHash,
          item.title.slice(0, 500),
          item.summary,
          src.name,
          src.trust_tier,
          item.published_at,
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
      inserted++;
    }
  }

  console.log(`news run complete: ${inserted} items inserted, ${llmCalls} LLM calls`);
}
