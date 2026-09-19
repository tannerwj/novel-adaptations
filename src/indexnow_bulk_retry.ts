// src/indexnow_bulk_retry.ts — TEMPORARY one-shot IndexNow bulk resubmission.
//
// Context: the 2026-09-18 bulk submit of the full sitemap (~3,757 URLs) failed
// on an IndexNow outage, and the scheduled retry died when its /tmp batch
// files were wiped. The INDEXNOW_KEY lives only as a worker secret, so the
// submit must run inside the worker. This route rebuilds the URL list from
// D1 via collectSitemapEntries and submits it in batches.
//
// Security: bearer-token gated against the BULK_RETRY_TOKEN worker secret.
// DELETE THIS FILE (and the secret) after the retry succeeds.

import { Hono } from 'hono';
import { collectSitemapEntries } from './seo';
import { indexNowPayload } from './indexnow';

export interface BulkRetryEnv {
  DB: D1Database;
  INDEXNOW_KEY?: string;
  BULK_RETRY_TOKEN?: string;
}

const BATCH_SIZE = 1000;

export function registerIndexNowBulkRetryRoute<
  E extends { Bindings: BulkRetryEnv },
>(app: Hono<E>): void {
  app.post('/api/internal/indexnow-bulk-retry', async (c) => {
    const token = c.env.BULK_RETRY_TOKEN?.trim();
    const presented = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
    if (!token || presented !== token) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const key = c.env.INDEXNOW_KEY?.trim();
    if (!key) return c.json({ error: 'indexnow_not_configured' }, 503);

    const origin = new URL(c.req.url).origin;
    const host = new URL(origin).host;

    // ?debug=1 submits a single URL and returns IndexNow's raw response body,
    // so we can see exactly what a 4xx means.
    if (new URL(c.req.url).searchParams.get('debug') === '1') {
      const res = await fetch('https://api.indexnow.org/indexnow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(indexNowPayload(host, key, [`${origin}/`])),
      });
      const body = await res.text();
      return c.json({ status: res.status, body: body.slice(0, 2000) });
    }

    // ?batch=N submits only the Nth 1-indexed batch (after ?delayMs, default 0),
    // so the caller can pace submissions to respect IndexNow rate limits.
    const batchParam = new URL(c.req.url).searchParams.get('batch');
    const delayMs = Math.min(
      120000,
      Math.max(0, parseInt(new URL(c.req.url).searchParams.get('delayMs') ?? '0', 10) || 0),
    );

    const entries = await collectSitemapEntries(c.env.DB, origin);
    const urls = [...new Set(entries.map((e) => e.loc))];

    const batches: Array<{ batch: number; count: number; status: number | string }> = [];
    const totalBatches = Math.ceil(urls.length / BATCH_SIZE);
    // No ?batch param → single request with ALL urls (up to the 10,000/request
    // IndexNow limit). One request can't trip the per-request rate limiter.
    const wanted = batchParam
      ? [parseInt(batchParam, 10)]
      : null;
    let chunks: Array<{ n: number; urls: string[] }>;
    if (wanted) {
      for (const n of wanted) {
        if (!Number.isInteger(n) || n < 1 || n > totalBatches) {
          return c.json({ error: 'bad_batch', totalBatches }, 400);
        }
      }
      chunks = wanted.map((n) => ({ n, urls: urls.slice((n - 1) * BATCH_SIZE, n * BATCH_SIZE) }));
    } else {
      chunks = [{ n: 1, urls }];
    }
    for (const { n, urls: chunk } of chunks) {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      let status: number | string;
      try {
        const res = await fetch('https://api.indexnow.org/indexnow', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(indexNowPayload(host, key, chunk)),
        });
        status = res.status;
      } catch (e) {
        status = `error: ${(e as Error).message}`;
      }
      batches.push({ batch: n, count: chunk.length, status });
    }

    const ok = batches.every((b) => b.status === 200 || b.status === 202);
    return c.json({ ok, total_urls: urls.length, totalBatches, batches });
  });
}
