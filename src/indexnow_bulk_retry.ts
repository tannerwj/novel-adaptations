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
      const res = await fetch('https://api.indexnow.org/indexnow.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(indexNowPayload(host, key, [`${origin}/`])),
      });
      const body = await res.text();
      return c.json({ status: res.status, body: body.slice(0, 2000) });
    }

    const entries = await collectSitemapEntries(c.env.DB, origin);
    const urls = [...new Set(entries.map((e) => e.loc))];

    const batches: Array<{ batch: number; count: number; status: number | string }> = [];
    for (let i = 0; i < urls.length; i += BATCH_SIZE) {
      const chunk = urls.slice(i, i + BATCH_SIZE);
      let status: number | string;
      try {
        const res = await fetch('https://api.indexnow.org/indexnow.json', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(indexNowPayload(host, key, chunk)),
        });
        status = res.status;
      } catch (e) {
        status = `error: ${(e as Error).message}`;
      }
      batches.push({ batch: batches.length + 1, count: chunk.length, status });
    }

    const ok = batches.every((b) => b.status === 200 || b.status === 202);
    return c.json({ ok, total_urls: urls.length, batches });
  });
}
