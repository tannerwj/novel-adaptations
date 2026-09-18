// src/indexnow.ts — IndexNow instant indexing (indexnow.org).
//
// Bing and Yandex (and others) accept instant URL submissions instead of
// waiting for a recrawl. Flow:
//   1. A random key is stored as the INDEXNOW_KEY worker secret
//      (`wrangler secret put INDEXNOW_KEY`) and served at /{key}.txt —
//      IndexNow requires the key file to exist on the host.
//   2. On adaptation intake, the new/changed book + screen-work + adaptation
//      URLs are submitted fire-and-forget via ctx.waitUntil.
// Everything is best-effort and fail-soft: a missing key disables the whole
// thing, and submission failures are logged, never thrown.

import { Hono } from 'hono';

export interface IndexNowEnv {
  INDEXNOW_KEY?: string;
}

/** Build the api.indexnow.org submission payload (pure — unit-tested). */
export function indexNowPayload(
  host: string,
  key: string,
  urls: string[],
): Record<string, unknown> {
  return {
    host,
    key,
    keyLocation: `https://${host}/${key}.txt`,
    urlList: urls,
  };
}

/**
 * Submit URLs to IndexNow. Never throws — indexing is advisory, and intake
 * must not fail because a search engine was unreachable.
 */
export async function submitIndexNow(
  env: IndexNowEnv,
  origin: string,
  urls: string[],
): Promise<void> {
  const key = env.INDEXNOW_KEY?.trim();
  if (!key || urls.length === 0) return;
  const host = new URL(origin).host;
  try {
    const res = await fetch('https://api.indexnow.org/indexnow.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(indexNowPayload(host, key, urls)),
    });
    // 200 = submitted, 202 = accepted; anything else is worth a log line.
    if (res.status !== 200 && res.status !== 202) {
      console.error(`indexnow submit failed: HTTP ${res.status}`);
    }
  } catch (e) {
    console.error('indexnow submit failed:', (e as Error).message);
  }
}

/**
 * Serve the IndexNow key file at /{key}.txt. Register after the static
 * single-segment routes (/sitemap.xml, /robots.txt, …) — on a non-match it
 * calls next() so page routes and the SPA fallback are unaffected.
 */
export function registerIndexNowKeyRoute<E extends { Bindings: IndexNowEnv }>(
  app: Hono<E>,
): void {
  app.get('/:keyFile', async (c, next) => {
    const key = c.env.INDEXNOW_KEY?.trim();
    if (key && c.req.param('keyFile') === `${key}.txt`) {
      return c.text(key, 200, { 'Content-Type': 'text/plain' });
    }
    await next();
  });
}
