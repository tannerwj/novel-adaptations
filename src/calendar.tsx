/**
 * src/calendar.tsx — Release calendar (Round 3, Track 1).
 *
 * The lifecycle differentiator: every screen work arranged by WHEN it lands
 * (or landed) — "Coming soon" grouped by month, "Recently released" for the
 * trailing window, and "TBA" for undated works.
 *
 * Mounted by src/index.tsx:
 *   GET /calendar — server-rendered release calendar.
 *
 * Date source of truth: screen_works.release_date (ISO YYYY-MM-DD, nullable).
 * String comparison is safe on ISO dates. "Today" is computed in UTC so the
 * bucketing matches how workers evaluate `date('now')`.
 */

import type { Hono } from 'hono';
import { Layout, PosterArt, themeOf, type AuthUser, type ThemeName } from './ui';
import { getUser } from './auth/session';

import {
  bucketWorks,
  type CalendarBindings,
  cleanDate,
  displayDate,
  formatDate,
  getCalendarFeed,
  getEarlierWorksForYear,
  kindLabelCal,
  listCalendarWorks,
  monthHeading,
  monthKey,
  RECENT_WINDOW_DAYS,
  recentWindowStart,
  relativeLabel,
  type CalendarBuckets,
  type CalendarWork,
} from './calendar_db';
export {
  getCalendarFeed,
  getEarlierWorksForYear,
  recentWindowStart,
  type CalendarBuckets,
  type CalendarWork,
};

function CalendarItem({ work, today }: { work: CalendarWork; today: string }) {
  const d = cleanDate(work);
  const dateLabel = !d
    ? 'TBA'
    : d.length === 4
      ? displayDate(d)
      : `${formatDate(d)} · ${relativeLabel(d, today)}`;
  return (
    <li>
      <a
        href={`/watch/${work.slug ?? work.id}`}
        tabIndex={-1}
        aria-hidden="true"
        style="width:44px;flex-shrink:0;display:block"
      >
        <PosterArt src={work.poster_url} title={work.title} />
      </a>
      <div style="min-width:0">
        <a
          href={`/watch/${work.slug ?? work.id}`}
          style="color:var(--text);font-weight:600;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"
        >
          {work.title}
        </a>
        <span class="meta">{dateLabel}</span>
      </div>
      <span class="shelf-kind kind-pill">{kindLabelCal(work.kind)}</span>
    </li>
  );
}

function ComingSoonSection({
  works,
  today,
}: {
  works: CalendarWork[];
  today: string;
}) {
  if (works.length === 0) {
    return <p class="empty">No upcoming releases with dates yet.</p>;
  }
  const groups: { heading: string; works: CalendarWork[] }[] = [];
  for (const w of works) {
    const d = cleanDate(w) ?? '';
    const key = monthKey(d);
    const last = groups[groups.length - 1];
    if (last && monthKey(cleanDate(last.works[0] as CalendarWork) ?? '') === key) {
      last.works.push(w);
    } else {
      groups.push({ heading: monthHeading(d), works: [w] });
    }
  }
  return (
    <>
      {groups.map((g) => (
        <div key={g.heading} class="cal-group">
          <h3 class="cal-month">
            {g.heading}
          </h3>
          <ul class="shelf-list">
            {g.works.map((w) => (
              <CalendarItem key={w.id} work={w} today={today} />
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

/**
 * Earlier releases, grouped by year in collapsible <details> — the newest
 * year starts open, the rest stay closed until asked for. Native HTML, no
 * JS: keyboard-operable, and lazy poster images inside closed groups are
 * never fetched, so the section stays light even with ~1000 titles.
 */
function EarlierReleases({
  works,
  today,
}: {
  works: CalendarWork[];
  today: string;
}) {
  if (works.length === 0) {
    return <p class="empty">No earlier releases.</p>;
  }
  const groups: { year: string; items: CalendarWork[] }[] = [];
  for (const w of works) {
    const year = (cleanDate(w) ?? '').slice(0, 4) || 'Unknown';
    const last = groups[groups.length - 1];
    if (last && last.year === year) last.items.push(w);
    else groups.push({ year, items: [w] });
  }
  return (
    <>
      {groups.map((g, i) => (
        <details class="cal-year" {...(i === 0 ? { open: true } : {})}>
          <summary>
            <span>{g.year}</span>
            <span class="meta">
              {g.items.length} {g.items.length === 1 ? 'title' : 'titles'}
            </span>
          </summary>
          <ul class="shelf-list">
            {g.items.map((w) => (
              <CalendarItem key={w.id} work={w} today={today} />
            ))}
          </ul>
        </details>
      ))}
    </>
  );
}

export function CalendarPage({
  works,
  today,
  user,
  theme,
}: {
  works: CalendarWork[];
  today: string;
  user: AuthUser;
  theme?: ThemeName;
}) {
  const windowStart = recentWindowStart(today);
  const { comingSoon, recentlyReleased, earlierReleases, tba } = bucketWorks(works, today, windowStart);
  return (
    <Layout title="Release calendar" user={user} theme={theme}>
      <p class="kicker">Release calendar</p>
      <h1 style="font-family:var(--serif);font-size:2rem;margin:.25rem 0 .5rem">
        When books hit the screen
      </h1>
      <p class="meta" style="margin-bottom:2rem">
        Every dated adaptation, in release order: upcoming first, then the
        last {RECENT_WINDOW_DAYS} days, then older releases, then the ones
        still waiting on a date.
      </p>

      <section class="shelf-group">
        <h2>Coming soon</h2>
        <ComingSoonSection works={comingSoon} today={today} />
      </section>

      <section class="shelf-group">
        <h2>Recently released</h2>
        {recentlyReleased.length === 0 ? (
          <p class="empty">Nothing released in the last {RECENT_WINDOW_DAYS} days.</p>
        ) : (
          <ul class="shelf-list">
            {recentlyReleased.map((w) => (
              <CalendarItem key={w.id} work={w} today={today} />
            ))}
          </ul>
        )}
      </section>

      <section class="shelf-group">
        <h2>Earlier releases</h2>
        <EarlierReleases works={earlierReleases} today={today} />
      </section>

      <section class="shelf-group">
        <h2>TBA</h2>
        {tba.length === 0 ? (
          <p class="empty">Everything here has a release date.</p>
        ) : (
          <ul class="shelf-list">
            {tba.map((w) => (
              <CalendarItem key={w.id} work={w} today={today} />
            ))}
          </ul>
        )}
      </section>
    </Layout>
  );
}

/** Bucketed calendar feed for the JSON API (same buckets the page renders). */
export function registerCalendarRoutes<E extends CalendarBindings>(
  app: Hono<{ Bindings: E }>,
): void {
  app.get('/calendar', async (c) => {
    const [works, sessionUser] = await Promise.all([
      listCalendarWorks(c.env.DB),
      getUser(c),
    ]);
    const user: AuthUser = sessionUser
      ? { email: sessionUser.email, isAdmin: sessionUser.isAdmin }
      : null;
    const today = new Date().toISOString().slice(0, 10);
    return c.html(<CalendarPage works={works} today={today} user={user} theme={themeOf(c)} />);
  });
}
