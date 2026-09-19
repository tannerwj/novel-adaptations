/** @jsxImportSource hono/jsx */
/**
 * src/watch.tsx — the screen-work page (`/watch/:slug`).
 *
 * Conceptual split, kept crisp in copy throughout:
 *   /adaptations/:slug = "the adaptation story" — the book→screen journey and
 *                      its status timeline.
 *   /watch/:slug       = "the screen work" — the film or series itself:
 *                      poster, synopsis, linked books/adaptations, news.
 *
 * Stubbed on purpose: synopsis/cast/crew arrive via TMDB enrichment
 * (migrations 0009 and 0026). Empty states say so —
 * nothing is faked. Affiliate/purchase links (purchase_url_screen) are stored
 * in the schema but NOT rendered yet (needs disclosure compliance first).
 */
import type { AuthUser, ThemeName } from './ui';
import { Layout, PosterArt, StatusBadge, TrustBadge } from './ui';
// Round 3: where-to-watch providers (TMDB, 7-day D1 cache).
import { WhereToWatch, type WatchProviders } from './watch_providers';
// Round 4 (community): ratings, hype meter, spoiler-safe reviews, list controls.
import { RatingWidget } from './ratings/ui';
import type { RatingSummary } from './ratings/db';
import { HypeWidget } from './hype/ui';
import { ReviewsSection, type ReviewView } from './reviews/ui';
import { AddToListControl } from './lists/ui';
import type { NewsItem, ScreenWorkDetail } from './db';
import { parseCastJson } from './db';

function kindLabel(kind: string): string {
  return kind === 'film' ? 'Film' : 'Series';
}

/** Year from a YYYY-MM-DD release_date, or null. */
function releaseYear(releaseDate: string | null | undefined): string | null {
  if (!releaseDate || releaseDate.length < 4) return null;
  const y = releaseDate.slice(0, 4);
  return /^\d{4}$/.test(y) ? y : null;
}

export function ScreenWorkPage({
  work,
  news,
  providers,
  origin,
  canonicalPath,
  user,
  theme,
  ratingSummary,
  userRating,
  reviews,
  userId,
  hype,
  userLists,
}: {
  work: ScreenWorkDetail;
  news: NewsItem[];
  providers?: WatchProviders | null;
  origin?: string;
  canonicalPath?: string;
  user?: AuthUser;
  theme?: ThemeName;
  ratingSummary?: RatingSummary;
  userRating?: number | null;
  reviews?: ReviewView[];
  userId?: number | null;
  /** Null when the work is released (hype is unreleased-only). */
  hype?: { average: number; count: number; userLevel: number | null } | null;
  userLists?: { id: number; title: string }[];
}) {
  const year = releaseYear(work.release_date);
  const authed = !!user?.email;
  const cast = parseCastJson(work.cast_json);
  const tmdbScore =
    work.tmdb_vote_count != null &&
    work.tmdb_vote_count > 0 &&
    work.tmdb_vote_average != null
      ? work.tmdb_vote_average
      : null;
  return (
    <Layout
      title={work.title}
      user={user}
      origin={origin}
      canonicalPath={canonicalPath}
      theme={theme}
      description={work.synopsis?.trim() || undefined}
      image={work.backdrop_url ?? work.poster_url ?? undefined}
    >
      <a class="back-link" href="/">← All adaptations</a>
      <div class="hero">
        {/* ARTWORK POLICY: the hero slot is 2:3 — always the poster (natively
            2:3). A 16:9 backdrop object-fit into this frame shows a meaningless
            vertical slice (see: Where the Wild Things Are). Backdrops are for
            16:9 surfaces only (og:image). */}
        <PosterArt
          src={work.poster_url}
          title={work.title}
          subtitle={`${kindLabel(work.kind)}${year ? ` · ${year}` : ''}`}
        />
        <div>
          <p class="kicker">The screen work — {kindLabel(work.kind).toLowerCase()}</p>
          <h1>{work.title}</h1>
          <p class="byline">
            {kindLabel(work.kind)}
            {year && ` · ${year}`}
          </p>
          <div class="hero-badges">
            <span class="kind-pill">{kindLabel(work.kind)}</span>
            {work.release_date && (
              <span class="kind-pill">📅 {work.release_date}</span>
            )}
            {tmdbScore !== null && (
              <span
                class="kind-pill"
                title={`TMDB audience score from ${work.tmdb_vote_count!.toLocaleString()} votes`}
              >
                ★ {tmdbScore.toFixed(1)} <span class="meta">TMDB</span>
              </span>
            )}
          </div>
          <p class="meta" style="margin-top:0.75rem">
            This page is about the screen work itself — the film or series. For
            the full book-to-screen story and its status timeline, see the{' '}
            {work.adaptations.length === 1 ? (
              <a href={`/adaptations/${work.adaptations[0]!.slug ?? work.adaptations[0]!.id}`}>
                adaptation page →
              </a>
            ) : (
              <>linked adaptation pages below.</>
            )}
          </p>
          <div class="hero-actions">
            <RatingWidget
              targetType="screen_work"
              targetId={work.id}
              average={ratingSummary?.average ?? 0}
              count={ratingSummary?.count ?? 0}
              userRating={userRating ?? null}
              signedIn={authed}
            />
            <AddToListControl
              targetType="screen_work"
              targetId={work.id}
              userLists={userLists ?? []}
              signedIn={authed}
            />
          </div>
        </div>
      </div>

      {hype && (
        <HypeWidget
          screenWorkId={work.id}
          average={hype.average}
          count={hype.count}
          userLevel={hype.userLevel}
          signedIn={authed}
        />
      )}

      <section class="panel" style="margin-top:1.5rem">
        <h2>Synopsis</h2>
        {work.synopsis && work.synopsis.trim() ? (
          <p>{work.synopsis}</p>
        ) : (
          <p class="empty" style="margin:0">
            Synopsis coming soon — we're enriching this page with data from TMDB.
          </p>
        )}
      </section>

      {providers && <WhereToWatch data={providers} />}

      <div class="detail-grid two" style="margin-top:1.5rem">
        <section class="panel">
          <h2>Details</h2>
          <dl class="facts">
            <dt>Title</dt>
            <dd>{work.title}</dd>
            <dt>Kind</dt>
            <dd>{kindLabel(work.kind)}</dd>
            <dt>Release</dt>
            <dd>{work.release_date ?? 'TBA'}</dd>
            {work.director && (
              <>
                <dt>Director</dt>
                <dd>{work.director}</dd>
              </>
            )}
            {work.creators && (
              <>
                <dt>Created by</dt>
                <dd>{work.creators}</dd>
              </>
            )}
          </dl>
        </section>
        <section class="panel">
          <h2>Cast &amp; crew</h2>
          {cast.length > 0 ? (
            <ul class="cast-strip">
              {cast.map((m) => (
                <li key={m.name}>
                  {m.profile_path ? (
                    <img
                      src={`https://image.tmdb.org/t/p/w185${m.profile_path}`}
                      alt={m.name}
                      loading="lazy"
                    />
                  ) : (
                    <span class="cast-fallback" aria-hidden="true">
                      {m.name
                        .split(' ')
                        .map((w) => w[0])
                        .slice(0, 2)
                        .join('')}
                    </span>
                  )}
                  <span class="cast-name">{m.name}</span>
                  {m.character && <span class="cast-char">{m.character}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <p class="empty" style="margin:0">
              Cast and crew appear here once TMDB has them listed.
            </p>
          )}
        </section>
      </div>

      <section style="margin-top:2rem">
        <h2 class="section-title">
          The books <span class="count">{work.books.length}</span>
        </h2>
        {work.books.length === 0 ? (
          <p class="empty">No linked books yet.</p>
        ) : (
          <ul class="shelf-list panel">
            {work.books.map((b) => (
              <li key={b.id}>
                <span>
                  <a href={`/books/${b.slug ?? b.id}`}>{b.title}</a>
                  <span class="meta"> by {b.authors}</span>
                </span>
                <span class="shelf-kind kind-pill">📚 Book</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section style="margin-top:2rem">
        <h2 class="section-title">
          The adaptation stories <span class="count">{work.adaptations.length}</span>
        </h2>
        {work.adaptations.length === 0 ? (
          <p class="empty">No adaptations tracked for this screen work yet.</p>
        ) : (
          <ul class="shelf-list panel">
            {work.adaptations.map((a) => (
              <li key={a.id}>
                <span>
                  <a href={`/adaptations/${a.slug ?? a.id}`}>{a.title}</a>
                </span>
                <StatusBadge status={a.status} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section style="margin-top:2rem">
        <h2 class="section-title">
          Related news <span class="count">{news.length}</span>
        </h2>
        {news.length === 0 ? (
          <p class="empty">
            No news matched to this title's books yet — new stories appear here
            as the pipeline classifies them.
          </p>
        ) : (
          <ul class="news-list panel">
            {news.map((n) => (
              <li key={n.id}>
                <p class="news-title">
                  <a href={n.url} target="_blank" rel="noopener noreferrer">
                    {n.title}
                  </a>
                </p>
                <p class="news-meta">
                  <TrustBadge tier={n.trust_tier} />
                  <span>{n.source}</span>
                  {n.published_at && <span>{n.published_at}</span>}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ReviewsSection
        targetType="screen_work"
        targetId={work.id}
        reviews={reviews ?? []}
        currentUserId={userId ?? null}
      />
    </Layout>
  );
}
