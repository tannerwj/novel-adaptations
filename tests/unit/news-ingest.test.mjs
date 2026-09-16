// tests/unit/news-ingest.test.mjs — focused unit tests for the news
// pipeline's keyword-gate → queue-disposition mapping (Bug 2 regression:
// below-gate items must be `dismissed`, never `pending`).
//
// Run: node --test tests/unit/
//
// Imports the real TS source via node type-stripping (node >= 23.6), so the
// mapping under test is the shipped code, not a copy. gate.ts is
// deliberately dependency-free so it imports cleanly outside the worker.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { keywordGate, prefilterDisposition } = await import(
  '../../src/news/gate.ts'
);

test('keywordGate passes adaptation-shaped headlines', () => {
  assert.equal(
    keywordGate('Dune: Part Two adaptation of the novel gets a film release date'),
    true,
  );
  assert.equal(
    keywordGate('Author optioned book rights for Netflix series'),
    true,
  );
});

test('keywordGate rejects non-adaptation headlines', () => {
  assert.equal(keywordGate('Box office results for the weekend'), false);
  assert.equal(keywordGate('Celebrity interview: favorite recipes'), false);
});

test('prefilterDisposition: gate pass -> pending, no dismiss_reason', () => {
  assert.deepEqual(prefilterDisposition(true), {
    status: 'pending',
    dismiss_reason: null,
  });
});

test('prefilterDisposition: gate fail -> dismissed with reason', () => {
  assert.deepEqual(prefilterDisposition(false), {
    status: 'dismissed',
    dismiss_reason: 'below keyword gate',
  });
});

test('end-to-end mapping: gate output feeds disposition correctly', () => {
  const adaptationLike = 'Studio options bestselling novel for film adaptation';
  const noise = 'Weekend box office: capes still win';
  assert.equal(
    prefilterDisposition(keywordGate(adaptationLike)).status,
    'pending',
  );
  const d = prefilterDisposition(keywordGate(noise));
  assert.equal(d.status, 'dismissed');
  assert.equal(d.dismiss_reason, 'below keyword gate');
});
