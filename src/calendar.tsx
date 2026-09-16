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

type CalendarBindings = { DB: D1Database };

export interface CalendarWork {
  id: number;
  title: string;
  kind: string;
  release_date: string | null;
  poster_url: string | null;
}

/** Works whose release_date falls in the trailing 120 days show as "recent". */
const RECENT_WINDOW_DAYS = 120;
const DAY_MS = 86_400_000;

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

export async function listCalendarWorks(db: D1Database): Promise<CalendarWork[]> {
  const { results } = await db
    .prepare(
      `SELECT id, title, kind, release_date, poster_url
         FROM screen_works
        ORDER BY title ASC`,
    )
    .all<CalendarWork>();
  return results;
}

function isIsoDate(s: string | null | undefined): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.trim());
}

function isYearOnly(s: string | undefined): boolean {
  return typeof s === 'string' && /^\d{4}$/.test(s.trim());
}

function cleanDate(w: CalendarWork): string | null {
  const d = w.release_date?.trim();
  return isIsoDate(d) || isYearOnly(d) ? (d as string).trim() : null;
}

/**
 * Year-only dates (honest imprecision: we know the year, not the day)
 * compare as the start of that year for bucketing/sorting. Displayed as
 * just the year — never inflated into a fabricated month/day.
 */
function comparableDate(d: string): string {
  return d.length === 4 ? `${d}-01-01` : d;
}

function displayDate(d: string): string {
  return d.length === 4 ? d : formatDate(d);
}

export interface CalendarBuckets {
  comingSoon: CalendarWork[];
  recentlyReleased: CalendarWork[];
  /** Dated works that released before the recent window, newest first. */
  earlierReleases: CalendarWork[];
  tba: CalendarWork[];
}

function bucketWorks(
  works: CalendarWork[],
  today: string,
  windowStart: string,
): CalendarBuckets {
  const comingSoon: CalendarWork[] = [];
  const recentlyReleased: CalendarWork[] = [];
  const earlierReleases: CalendarWork[] = [];
  const tba: CalendarWork[] = [];
  for (const w of works) {
    const d = cleanDate(w);
    if (!d) {
      tba.push(w);
    } else if (comparableDate(d) >= today) {
      comingSoon.push(w);
    } else if (comparableDate(d) >= windowStart) {
      recentlyReleased.push(w);
    } else {
      // Dated works older than the window get their own section rather than
      // vanishing from the calendar; they stay reachable via Browse too.
      earlierReleases.push(w);
    }
  }
  const byDateAsc = (a: CalendarWork, b: CalendarWork) =>
    (comparableDate(cleanDate(a) ?? '').localeCompare(
      comparableDate(cleanDate(b) ?? ''),
    ) ||
      a.title.localeCompare(b.title));
  const byDateDesc = (a: CalendarWork, b: CalendarWork) => -byDateAsc(a, b);
  comingSoon.sort(byDateAsc);
  recentlyReleased.sort(byDateDesc);
  earlierReleases.sort(byDateDesc);
  tba.sort((a, b) => a.title.localeCompare(b.title));
  return { comingSoon, recentlyReleased, earlierReleases, tba };
}

function monthHeading(iso: string): string {
  const parts = iso.split('-');
  const y = Number(parts[0] ?? '0');
  const m = Number(parts[1] ?? '1');
  return `${MONTH_NAMES[m - 1] ?? ''} ${y}`;
}

function monthKey(iso: string): string {
  return iso.slice(0, 7); // YYYY-MM
}

function formatDate(iso: string): string {
  const parts = iso.split('-');
  const y = Number(parts[0] ?? '0');
  const m = Number(parts[1] ?? '1');
  const d = Number(parts[2] ?? '1');
  return `${MONTH_NAMES[m - 1] ?? ''} ${d}, ${y}`;
}

/** "today" / "tomorrow" / "in N days" / "yesterday" / "N days ago". */
function relativeLabel(iso: string, today: string): string {
  const diff = Math.round(
    (Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS,
  );
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  if (diff > 1) return `in ${diff} days`;
  return `${-diff} days ago`;
}

function kindLabelCal(kind: string): string {
  return kind === 'series' ? 'Series' : 'Film';
}

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
        href={`/watch/${work.id}`}
        tabIndex={-1}
        aria-hidden="true"
        style="width:44px;flex-shrink:0;display:block"
      >
        <PosterArt src={work.poster_url} title={work.title} />
      </a>
      <div style="min-width:0">
        <a
          href={`/watch/${work.id}`}
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
  const windowStart = new Date(Date.parse(`${today}T00:00:00Z`) - RECENT_WINDOW_DAYS * DAY_MS)
    .toISOString()
    .slice(0, 10);
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
export async function getCalendarFeed(
  db: D1Database,
): Promise<{ today: string; buckets: CalendarBuckets }> {
  const works = await listCalendarWorks(db);
  const today = new Date().toISOString().slice(0, 10);
  const windowStart = new Date(
    Date.parse(`${today}T00:00:00Z`) - RECENT_WINDOW_DAYS * DAY_MS,
  )
    .toISOString()
    .slice(0, 10);
  return { today, buckets: bucketWorks(works, today, windowStart) };
}

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
