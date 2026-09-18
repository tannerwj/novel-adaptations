// tests/unit/indexnow.test.mjs — IndexNow payload builder (the network call
// itself is best-effort and never unit-tested against the live endpoint).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./hooks/extensionless.mjs', import.meta.url));
const { indexNowPayload, submitIndexNow } = await import('../../src/indexnow.ts');

test('indexNowPayload builds the api.indexnow.org submission shape', () => {
  const p = indexNowPayload('noveladaptations.com', 'abc123', [
    'https://noveladaptations.com/books/dune-frank-herbert',
    'https://noveladaptations.com/watch/dune-part-two-2024',
  ]);
  assert.equal(p.host, 'noveladaptations.com');
  assert.equal(p.key, 'abc123');
  assert.equal(p.keyLocation, 'https://noveladaptations.com/abc123.txt');
  assert.deepEqual(p.urlList, [
    'https://noveladaptations.com/books/dune-frank-herbert',
    'https://noveladaptations.com/watch/dune-part-two-2024',
  ]);
});

test('submitIndexNow no-ops without a key or URLs (never throws)', async () => {
  await submitIndexNow({}, 'https://noveladaptations.com', ['https://noveladaptations.com/']);
  await submitIndexNow({ INDEXNOW_KEY: 'abc123' }, 'https://noveladaptations.com', []);
});
