/**
 * src/news/gate.ts — pure keyword pre-filter for the news pipeline.
 *
 * Dependency-free on purpose: the unit tests import this module directly
 * under plain node (type-stripping), without dragging in the worker's
 * enrichment/import chain.
 */

const ADAPTATION_TERMS = ['novel', 'book', 'adaptation', 'based on', 'optioned', 'rights', 'author'];
const SCREEN_TERMS = ['film', 'movie', 'series', 'show', 'tv', 'netflix', 'hulu', 'apple tv', 'casting', 'director', 'streaming'];

export function keywordGate(text: string): boolean {
  const t = text.toLowerCase();
  return ADAPTATION_TERMS.some((w) => t.includes(w)) && SCREEN_TERMS.some((w) => t.includes(w));
}

/**
 * Keyword-gate → queue disposition (spec §4). Items failing the gate are
 * non-adaptation noise: recorded as `dismissed` so they never reach the
 * curation queue and never consume the pending quarantine cap.
 */
export function prefilterDisposition(passesGate: boolean): {
  status: 'pending' | 'dismissed';
  dismiss_reason: string | null;
} {
  return passesGate
    ? { status: 'pending', dismiss_reason: null }
    : { status: 'dismissed', dismiss_reason: 'below keyword gate' };
}
