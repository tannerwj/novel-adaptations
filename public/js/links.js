// public/js/links.js — canonical detail-page URL builders.
//
// Every API object that represents a book / screen work / adaptation carries
// a `slug` (migration 0020). The id is kept as a fallback so links still
// resolve if a row was never backfilled. The helpers accept the field names
// the API actually returns (snake_case projections with book_id/bookId etc.),
// not just the DB interface names.

/** `/books/<slug>` for a book-shaped object (Book, PopularBook, book hit, shelf entry…). */
export function bookUrl(b) {
  return `/books/${b.slug ?? b.book_slug ?? b.id ?? b.bookId ?? b.book_id ?? b.target_id}`;
}

/** `/watch/<slug>` for a screen-work-shaped object (ScreenWork, CalendarWork…). */
export function watchUrl(w) {
  return `/watch/${w.slug ?? w.screen_slug ?? w.id ?? w.screen_work_id}`;
}

/** `/adaptations/<slug>` for an AdaptationSummary, adaptation hit, or shelf entry. */
export function adaptationUrl(a) {
  return `/adaptations/${a.adaptation_slug ?? a.slug ?? a.id ?? a.target_id}`;
}
