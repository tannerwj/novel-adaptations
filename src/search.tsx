// src/search.tsx — Track 3: site-wide search.
//
//   GET /search?q= — one page, results grouped by type:
//     • Books — title + authors → /books/:slug
//     • Films & series — poster thumbnail, title, kind pill → /watch/:slug
//     • Adaptation stories — book → screen title, status badge → /adaptations/:slug
//
// Implementation: parameterized LIKE queries (case-insensitive substring
// match on title/authors), one query per result group, LIMIT 12 each.
// Results are ranked in SQL by a CASE-based relevance tier — exact title
// match, then title-prefix, then word-start, then substring, with exact and
// prefix author matches ranked well too; titles starting with "The " are
// normalized for exact/prefix comparisons. The WHERE clause only admits
// genuine matches, so ranking reorders but never invents results.
// FTS5 was deliberately NOT used — decision documented in TRACK3_NOTES.md.
//
// XSS: Hono JSX auto-escapes every interpolated value; the query is passed
// back into the search form as value={q} and is never concatenated into raw
// HTML. LIKE wildcards in user input are escaped so `%` / `_` match
// literally.

import type { Hono } from 'hono';
import { Layout, PosterArt, StatusBadge, themeOf, type AuthUser, type ThemeName } from './ui';
import { getUser } from './auth/session';
import { searchFilterFragments } from './search_filters';
import {
  getPopularBooks,
  QUERY_MAX_LEN,
  RESULT_LIMIT,
  searchAdaptations,
  searchBooks,
  searchScreenWorks,
  searchStatements,
  type AdaptationHit,
  type BookHit,
  type PopularBook,
  type ScreenWorkHit,
  type SearchFilters,
} from './search_db';
export {
  getPopularBooks,
  QUERY_MAX_LEN,
  RESULT_LIMIT,
  searchAdaptations,
  searchBooks,
  searchScreenWorks,
  searchStatements,
  type AdaptationHit,
  type BookHit,
  type PopularBook,
  type ScreenWorkHit,
  type SearchFilters,
};


// --- Small helpers (not exported from ui.tsx, so local copies) ----------------

function kindLabel(kind: string): string {
  return kind === 'film' ? 'Film' : 'Series';
}

/** Simple stable string hash → hue, for cover-art fallback gradients. */
function thumbHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

function BookThumb({ title, coverUrl }: { title: string; coverUrl: string | null }) {
  const hue = thumbHue(title);
  const gradient = `linear-gradient(135deg, hsl(${hue}, 48%, 24%), hsl(${(hue + 50) % 360}, 55%, 12%))`;
  const clean = coverUrl && coverUrl.trim() ? coverUrl.trim() : null;
  return (
    <div class="rank-thumb">
      <div class="mini-art" style={`background:${gradient}`}>
        {title.charAt(0)}
      </div>
      {clean && <img src={clean} alt="" loading="lazy" onerror="this.remove()" />}
    </div>
  );
}

// --- Page components ----------------------------------------------------------

function SearchForm({ q }: { q: string }) {
  return (
    <form
      class="search-form"
      action="/search"
      method="get"
      role="search"
    >
      <input
        type="search"
        name="q"
        value={q}
        placeholder="Search books, movies, shows…"
        aria-label="Search books, movies, and shows"
        maxlength={QUERY_MAX_LEN}
      />
      <button class="btn btn-primary" type="submit">
        Search
      </button>
    </form>
  );
}

function PopularBooks({ books, heading }: { books: PopularBook[]; heading?: string }) {
  if (books.length === 0) return null;
  return (
    <section aria-label={heading ?? 'Popular right now'}>
      <h2 class="section-title">{heading ?? 'Popular right now'}</h2>
      <ol class="leaderboard">
        {books.map((b, i) => (
          <li class="rank-row" key={b.id}>
            <div class="rank-num" aria-label={`Rank ${i + 1}`}>
              {i + 1}
            </div>
            <BookThumb title={b.title} coverUrl={b.cover_url} />
            <div class="rank-info">
              <p class="rank-title">
                <a href={`/books/${b.slug ?? b.id}`}>{b.title}</a>
              </p>
              <p class="rank-authors">{b.authors}</p>
            </div>
            <div class="rank-votes">
              <div>
                <div class="votes">{b.votes}</div>
                <div class="votes-label">votes</div>
              </div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function SearchPage({
  q,
  user,
  books,
  works,
  stories,
  popular,
  theme,
}: {
  q: string;
  user: AuthUser;
  books: BookHit[];
  works: ScreenWorkHit[];
  stories: AdaptationHit[];
  popular: PopularBook[];
  theme?: ThemeName;
}) {
  const total = books.length + works.length + stories.length;
  return (
    <Layout title={q ? `Results for “${q}”` : 'Search'} user={user} theme={theme}>
      <p class="kicker">Search</p>
      <h1 class="display-title">
        {q ? (
          <>
            Results for <span style="font-style:italic">“{q}”</span>
          </>
        ) : (
          'Search Novel Adaptations'
        )}
      </h1>
      <SearchForm q={q} />

      {!q ? (
        // Empty query: never an error page — show popular suggestions instead.
        popular.length > 0 ? (
          <PopularBooks books={popular} />
        ) : (
          <p class="empty">No books tracked yet. Check back soon.</p>
        )
      ) : total === 0 ? (
        // No matches: friendly message + suggestions, NOT a 404.
        <>
          <p class="empty">
            No results for “{q}”. Try a different title or author spelling.
          </p>
          <PopularBooks books={popular} heading="Popular right now" />
        </>
      ) : (
        <>
          {books.length > 0 && (
            <section aria-label="Books" style="margin-bottom:2.5rem">
              <h2 class="section-title">
                Books <span class="count">{books.length}</span>
              </h2>
              <ul class="search-result-list">
                {books.map((b) => (
                  <li key={b.id}>
                    <a href={`/books/${b.slug ?? b.id}`}>{b.title}</a>
                    <span class="sub"> by {b.authors}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {works.length > 0 && (
            <section aria-label="Films and series" style="margin-bottom:2.5rem">
              <h2 class="section-title">
                Films &amp; series <span class="count">{works.length}</span>
              </h2>
              <div class="poster-grid">
                {works.map((w) => (
                  <article class="poster-card" key={w.id}>
                    <a
                      class="poster-link"
                      href={`/watch/${w.slug ?? w.id}`}
                      aria-label={`${w.title} — ${kindLabel(w.kind)}`}
                    >
                      <PosterArt
                        src={w.poster_url}
                        title={w.title}
                        subtitle={kindLabel(w.kind)}
                      />
                    </a>
                    <div class="card-body">
                      <h3 class="card-title">
                        <a href={`/watch/${w.slug ?? w.id}`}>{w.title}</a>
                      </h3>
                      <div class="card-badges">
                        <span class="kind-pill">{kindLabel(w.kind)}</span>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}

          {stories.length > 0 && (
            <section aria-label="Adaptation stories" style="margin-bottom:2.5rem">
              <h2 class="section-title">
                Adaptation stories <span class="count">{stories.length}</span>
              </h2>
              <ul class="search-result-list">
                {stories.map((s) => (
                  <li key={s.id} class="adapt-story">
                    <a href={`/adaptations/${s.slug ?? s.id}`}>
                      {s.book_title} → {s.screen_title}
                    </a>
                    <span class="sub">
                      {kindLabel(s.screen_kind)} · by {s.book_authors}
                    </span>
                    <StatusBadge status={s.status} />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </Layout>
  );
}

// --- Route registration -------------------------------------------------------

export function registerSearchRoutes<E extends { DB: D1Database }>(
  app: Hono<{ Bindings: E }>,
): void {
  app.get('/search', async (c) => {
    const rawQ = c.req.query('q') ?? '';
    const q = rawQ.trim().slice(0, QUERY_MAX_LEN);
    const sessionUser = await getUser(c);
    const user: AuthUser = sessionUser
      ? { email: sessionUser.email, isAdmin: sessionUser.isAdmin }
      : null;

    if (!q) {
      const popular = await getPopularBooks(c.env.DB);
      return c.html(<SearchPage q="" user={user} books={[]} works={[]} stories={[]} popular={popular} theme={themeOf(c)} />);
    }

    // One query per result group, run in parallel.
    const [books, works, stories] = await Promise.all([
      searchBooks(c.env.DB, q),
      searchScreenWorks(c.env.DB, q),
      searchAdaptations(c.env.DB, q),
    ]);

    // No matches anywhere → fetch popular suggestions for the fallback.
    const popular =
      books.length + works.length + stories.length === 0
        ? await getPopularBooks(c.env.DB)
        : [];

    return c.html(
      <SearchPage q={q} user={user} books={books} works={works} stories={stories} popular={popular} theme={themeOf(c)} />,
    );
  });
}
