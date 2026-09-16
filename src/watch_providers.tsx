/** @jsxImportSource hono/jsx */
/**
 * src/watch_providers.ts — "Where to watch" (TRACK 2).
 *
 * Fetches stream/rent/buy providers for a screen work from TMDB's
 * /watch/providers endpoint, caches the parsed payload in the
 * `watch_provider_cache` table (migration 0011), and renders the
 * <WhereToWatch> section for the /watch/:id page.
 *
 * Follows the soft-fail/no-key pattern from src/tmdb.ts exactly: no
 * TMDB_API_KEY, no tmdb_id, a network blip, a non-OK response, or bad
 * JSON all resolve to null — nothing ever throws, and nothing the
 * caller does is load-bearing for the page render.
 */

import type { TmdbEnv, TmdbFetcher } from './tmdb';

export interface WatchProvider {
  id: number;
  name: string;
  /** `https://image.tmdb.org/t/p/w92{logo_path}` — always set. */
  logo: string;
}

export interface WatchProviders {
  flatrate: WatchProvider[];
  rent: WatchProvider[];
  buy: WatchProvider[];
  /** TMDB-hosted page with the full provider list; may be null. */
  link: string | null;
}

/** Minimal surface of ExecutionCtx we need (stale-while-revalidate). */
export interface WaitUntilCtx {
  waitUntil(promise: Promise<unknown>): void;
}

const TMDB_API = 'https://api.themoviedb.org/3';
const LOGO_SIZE = 'w92';

interface TmdbProviderEntry {
  provider_id?: number;
  provider_name?: string;
  logo_path?: string | null;
}

function toProvider(entry: TmdbProviderEntry): WatchProvider | null {
  if (
    !entry ||
    !Number.isInteger(entry.provider_id) ||
    typeof entry.provider_name !== 'string' ||
    typeof entry.logo_path !== 'string' ||
    !entry.logo_path
  ) {
    return null;
  }
  return {
    id: entry.provider_id as number,
    name: entry.provider_name,
    logo: `https://image.tmdb.org/t/p/${LOGO_SIZE}${entry.logo_path}`,
  };
}

function toProviders(raw: unknown): WatchProvider[] {
  if (!Array.isArray(raw)) return [];
  const out: WatchProvider[] = [];
  const seen = new Set<number>();
  for (const entry of raw) {
    const p = toProvider(entry as TmdbProviderEntry);
    if (p && !seen.has(p.id)) {
      seen.add(p.id);
      out.push(p);
    }
  }
  return out;
}

/**
 * Fetch US watch providers for a TMDB movie or TV id. Kind is the
 * screen_works kind ('film' | 'series'). Any failure (no key, network,
 * non-OK, bad JSON, no US region in the payload) → null.
 */
export async function fetchWatchProviders(
  apiKey: string,
  tmdbId: number,
  kind: 'film' | 'series',
  fetcher: TmdbFetcher = fetch,
): Promise<WatchProviders | null> {
  if (!apiKey || !Number.isInteger(tmdbId) || tmdbId <= 0) return null;

  const endpoint = kind === 'series' ? `tv/${tmdbId}` : `movie/${tmdbId}`;
  const params = new URLSearchParams({ api_key: apiKey });
  const url = `${TMDB_API}/${endpoint}/watch/providers?${params}`;

  let res: Response;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      res = await fetcher(url, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return null; // Network failure / abort → graceful null.
  }
  if (!res.ok) return null;

  let payload: {
    results?: Record<string, unknown>;
  };
  try {
    payload = (await res.json()) as { results?: Record<string, unknown> };
  } catch {
    return null;
  }

  const us = payload.results?.US as
    | {
        link?: unknown;
        flatrate?: unknown;
        rent?: unknown;
        buy?: unknown;
      }
    | undefined;
  if (!us || typeof us !== 'object') return null; // No US region → null.

  return {
    flatrate: toProviders(us.flatrate),
    rent: toProviders(us.rent),
    buy: toProviders(us.buy),
    link: typeof us.link === 'string' && us.link ? us.link : null,
  };
}

interface CacheRow {
  providers_json: string;
}

/**
 * Resolve watch providers for a screen work, using the cache table:
 *
 * - No tmdb_id → null.
 * - Cache row updated within 7 days → parsed payload, no fetch.
 * - Stale cache + key present → return the stale payload NOW and
 *   refresh in the background via ctx.waitUntil (stale-while-revalidate).
 * - Cold cache + key present → fetch (bounded by the 10s timeout),
 *   persist with INSERT OR REPLACE, and return the result.
 * - No key → whatever the cache has, or null.
 *
 * Never throws — every failure mode falls through to cached-or-null.
 * The only request-blocking network call is a cold cache miss, bounded
 * by the fetch's 10s abort timeout.
 */
export async function getWatchProviders(
  db: D1Database,
  ctx: WaitUntilCtx,
  tmdbEnv: TmdbEnv,
  work: { id: number; tmdb_id: number | null; kind: 'film' | 'series' },
): Promise<WatchProviders | null> {
  try {
    if (!work || !Number.isInteger(work.id) || !work.tmdb_id) return null;

    const fresh = await db
      .prepare(
        `SELECT providers_json FROM watch_provider_cache
         WHERE screen_work_id = ?1
           AND datetime(updated_at, '+7 days') >= datetime('now')`,
      )
      .bind(work.id)
      .first<CacheRow>();
    if (fresh) return parseCached(fresh.providers_json);

    const stale = await db
      .prepare(
        `SELECT providers_json FROM watch_provider_cache
         WHERE screen_work_id = ?1`,
      )
      .bind(work.id)
      .first<CacheRow>();
    const staleData = stale ? parseCached(stale.providers_json) : null;

    const apiKey = tmdbEnv.TMDB_API_KEY;
    if (!apiKey) return staleData; // No key → best effort from cache.

    if (staleData) {
      // Stale-while-revalidate: answer now, refresh after the response.
      ctx.waitUntil(
        refreshCache(db, apiKey, work.id, work.tmdb_id, work.kind).catch(
          () => {},
        ),
      );
      return staleData;
    }

    // Cold miss: fetch inline, but bounded by the 10s timeout inside
    // fetchWatchProviders; on any failure we simply return null.
    const fetched = await fetchWatchProviders(
      apiKey,
      work.tmdb_id,
      work.kind,
    );
    if (fetched) {
      await writeCache(db, work.id, fetched);
    }
    return fetched;
  } catch {
    return null;
  }
}

function parseCached(json: string): WatchProviders | null {
  try {
    const parsed = JSON.parse(json) as Partial<WatchProviders>;
    if (!parsed || typeof parsed !== 'object') return null;
    const asArray = (v: unknown): WatchProvider[] =>
      Array.isArray(v) ? (v as WatchProvider[]) : [];
    return {
      flatrate: asArray(parsed.flatrate),
      rent: asArray(parsed.rent),
      buy: asArray(parsed.buy),
      link: typeof parsed.link === 'string' && parsed.link ? parsed.link : null,
    };
  } catch {
    return null;
  }
}

async function writeCache(
  db: D1Database,
  screenWorkId: number,
  data: WatchProviders,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO watch_provider_cache
         (screen_work_id, providers_json, updated_at)
       VALUES (?1, ?2, datetime('now'))`,
    )
    .bind(screenWorkId, JSON.stringify(data))
    .run();
}

async function refreshCache(
  db: D1Database,
  apiKey: string,
  screenWorkId: number,
  tmdbId: number,
  kind: 'film' | 'series',
): Promise<void> {
  const fetched = await fetchWatchProviders(apiKey, tmdbId, kind);
  if (fetched) {
    await writeCache(db, screenWorkId, fetched);
  }
  // A null fetch leaves the stale row in place — nothing to do.
}

/**
 * Fetch US watch providers for a screen work and persist them to the cache.
 * Used by the bulk backfill endpoint (src/enrichment.ts). Returns true when
 * a payload was written, false on any failure (no key, no TMDB match, no US
 * region, network/API failure). Never throws.
 */
export async function fetchAndCacheProviders(
  db: D1Database,
  apiKey: string,
  screenWorkId: number,
  tmdbId: number,
  kind: 'film' | 'series',
): Promise<boolean> {
  try {
    const fetched = await fetchWatchProviders(apiKey, tmdbId, kind);
    if (!fetched) return false;
    await writeCache(db, screenWorkId, fetched);
    return true;
  } catch {
    return false;
  }
}

/** One provider group (Stream / Rent / Buy). */
function ProviderGroup({
  title,
  providers,
}: {
  title: string;
  providers: WatchProvider[];
}) {
  if (providers.length === 0) return null;
  return (
    <div style="margin-bottom:1rem">
      <h3
        class="meta"
        style="margin:0 0 0.5rem;text-transform:uppercase;letter-spacing:0.05em"
      >
        {title}
      </h3>
      <ul
        style="list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:0.75rem"
      >
        {providers.map((p) => (
          <li
            key={p.id}
            style="display:flex;align-items:center;gap:0.5rem"
          >
            <img
              src={p.logo}
              alt={p.name}
              width="36"
              height="36"
              loading="lazy"
              style="border-radius:6px"
            />
            <span>{p.name}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * "Where to watch" section for the screen-work page. Renders nothing
 * (null) when there is no provider data — no broken empty box.
 */
export function WhereToWatch({ data }: { data: WatchProviders | null }) {
  if (!data) return null;
  const hasAny =
    data.flatrate.length > 0 ||
    data.rent.length > 0 ||
    data.buy.length > 0;
  if (!hasAny && !data.link) return null;

  return (
    <section class="panel">
      <h2>Where to watch</h2>
      <ProviderGroup title="Stream" providers={data.flatrate} />
      <ProviderGroup title="Rent" providers={data.rent} />
      <ProviderGroup title="Buy" providers={data.buy} />
      {data.link && (
        <p style="margin:0.5rem 0 0">
          <a
            href={data.link}
            target="_blank"
            rel="noopener noreferrer"
          >
            More options ↗
          </a>
        </p>
      )}
      <p class="meta" style="margin:0.75rem 0 0;font-size:0.8rem">
        Watch provider data via JustWatch
      </p>
    </section>
  );
}
