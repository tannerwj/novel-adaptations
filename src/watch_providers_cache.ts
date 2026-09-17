/**
 * src/watch_providers_cache.ts — "Where to watch" provider cache (TRACK 2).
 *
 * Pure provider-fetch/cache logic with no JSX, so it stays unit-testable
 * under node type-stripping (node cannot load .tsx). The <WhereToWatch>
 * component lives in src/watch_providers.tsx and re-exports this module.
 *
 * Fetches stream/rent/buy providers for a screen work from TMDB's
 * /watch/providers endpoint and caches the parsed payload in the
 * `watch_provider_cache` table (migration 0011).
 *
 * Follows the soft-fail/no-key pattern from src/tmdb.ts exactly: no
 * TMDB_API_KEY, no tmdb_id, a network blip, a non-OK response, or bad
 * JSON all resolve to null — nothing ever throws, and nothing the
 * caller does is load-bearing for the page render.
 */

import { tmdbGetJson, type TmdbEnv, type TmdbFetcher } from './tmdb';

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
 * Detailed provider fetch: distinguishes transport/API failure
 * ({ ok: false }) from a successful TMDB response that simply has no US
 * providers ({ ok: true, providers: null }). Lets bulk backfills cache a
 * negative (empty) entry for no-data titles so they converge instead of
 * retrying forever.
 */
export async function fetchWatchProvidersDetailed(
  apiKey: string,
  tmdbId: number,
  kind: 'film' | 'series',
  fetcher: TmdbFetcher = fetch,
): Promise<{ ok: boolean; providers: WatchProviders | null }> {
  const fail = { ok: false, providers: null } as const;
  if (!apiKey || !Number.isInteger(tmdbId) || tmdbId <= 0) return { ...fail };

  const endpoint = kind === 'series' ? `tv/${tmdbId}` : `movie/${tmdbId}`;
  const params = new URLSearchParams({ api_key: apiKey });
  const url = `${TMDB_API}/${endpoint}/watch/providers?${params}`;

  // The deadline covers the body too: a stalled response aborts instead of
  // hanging the worker. Any failure → retry later.
  let payload: { results?: Record<string, unknown> } | null;
  try {
    const { status, json } = await tmdbGetJson(url, fetcher);
    if (status !== 200) return { ...fail };
    payload = json as { results?: Record<string, unknown> } | null;
  } catch {
    return { ...fail };
  }

  const us = payload?.results?.US as
    | {
        link?: unknown;
        flatrate?: unknown;
        rent?: unknown;
        buy?: unknown;
      }
    | undefined;
  // TMDB answered fine but has no US region → legitimate "no data".
  if (!us || typeof us !== 'object') return { ok: true, providers: null };

  return {
    ok: true,
    providers: {
      flatrate: toProviders(us.flatrate),
      rent: toProviders(us.rent),
      buy: toProviders(us.buy),
      link: typeof us.link === 'string' && us.link ? us.link : null,
    },
  };
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
  return (await fetchWatchProvidersDetailed(apiKey, tmdbId, kind, fetcher))
    .providers;
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
    // fetchWatchProvidersDetailed. A successful empty result is a real
    // answer (no US availability) — cache it as a negative entry so we
    // don't refetch on every view. Only true failures leave the cache
    // alone and return null.
    const { ok, providers } = await fetchWatchProvidersDetailed(
      apiKey,
      work.tmdb_id,
      work.kind,
    );
    if (!ok) return null;
    const data: WatchProviders = providers ?? {
      flatrate: [],
      rent: [],
      buy: [],
      link: null,
    };
    await writeCache(db, work.id, data);
    return data;
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
  const { ok, providers } = await fetchWatchProvidersDetailed(
    apiKey,
    tmdbId,
    kind,
  );
  if (!ok) return; // Failure: preserve the stale row.
  // Successful empty responses are cached as negative entries so stale
  // providers can't linger and no-data titles aren't refetched forever.
  await writeCache(db, screenWorkId, providers ?? { flatrate: [], rent: [], buy: [], link: null });
}

/**
 * Fetch US watch providers for a screen work and persist them to the cache.
 * Used by the bulk backfill endpoint (src/enrichment.ts). Returns true when
 * a payload was written, false on transport/API failure (no key, no TMDB
 * match, network/API failure). A successful TMDB response with no US
 * providers writes an empty (negative) cache entry so backfills converge
 * instead of retrying no-data titles forever. Never throws.
 */
export async function fetchAndCacheProviders(
  db: D1Database,
  apiKey: string,
  screenWorkId: number,
  tmdbId: number,
  kind: 'film' | 'series',
): Promise<boolean> {
  try {
    const { ok, providers } = await fetchWatchProvidersDetailed(
      apiKey,
      tmdbId,
      kind,
    );
    if (!ok) return false;
    await writeCache(
      db,
      screenWorkId,
      providers ?? { flatrate: [], rent: [], buy: [], link: null },
    );
    return true;
  } catch {
    return false;
  }
}
