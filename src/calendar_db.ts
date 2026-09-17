/**
 * src/calendar_db.ts — release-calendar data layer.
 *
 * Pure .ts module (no JSX) shared by the legacy page route
 * (src/calendar.tsx) and the v1 JSON API (src/api/v1.ts), so node unit
 * tests can import the API router without the SSR UI bundle.
 */

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


export type CalendarBindings = { DB: D1Database };

export interface CalendarWork {
  id: number;
  title: string;
  kind: string;
  release_date: string | null;
  poster_url: string | null;
  slug: string | null;
}

/** Works whose release_date falls in the trailing 120 days show as "recent". */
export const RECENT_WINDOW_DAYS = 120;
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
      `SELECT id, title, kind, release_date, poster_url, slug
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

export function cleanDate(w: CalendarWork): string | null {
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

export function displayDate(d: string): string {
  return d.length === 4 ? d : formatDate(d);
}

export interface CalendarBuckets {
  comingSoon: CalendarWork[];
  recentlyReleased: CalendarWork[];
  /** Dated works that released before the recent window, newest first. */
  earlierReleases: CalendarWork[];
  tba: CalendarWork[];
}

export function bucketWorks(
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

export function monthHeading(iso: string): string {
  const parts = iso.split('-');
  const y = Number(parts[0] ?? '0');
  const m = Number(parts[1] ?? '1');
  return `${MONTH_NAMES[m - 1] ?? ''} ${y}`;
}

export function monthKey(iso: string): string {
  return iso.slice(0, 7); // YYYY-MM
}

export function formatDate(iso: string): string {
  const parts = iso.split('-');
  const y = Number(parts[0] ?? '0');
  const m = Number(parts[1] ?? '1');
  const d = Number(parts[2] ?? '1');
  return `${MONTH_NAMES[m - 1] ?? ''} ${d}, ${y}`;
}

/** "today" / "tomorrow" / "in N days" / "yesterday" / "N days ago". */
export function relativeLabel(iso: string, today: string): string {
  const diff = Math.round(
    (Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS,
  );
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  if (diff > 1) return `in ${diff} days`;
  return `${-diff} days ago`;
}

export function kindLabelCal(kind: string): string {
  return kind === 'series' ? 'Series' : 'Film';
}
export async function getCalendarFeed(db: D1Database): Promise<{
  today: string;
  buckets: CalendarBuckets;
  earlierYears: { year: string; count: number }[];
}> {
  const works = await listCalendarWorks(db);
  const today = new Date().toISOString().slice(0, 10);
  const windowStart = recentWindowStart(today);
  const buckets = bucketWorks(works, today, windowStart);
  const years = new Map<string, number>();
  for (const w of buckets.earlierReleases) {
    const year = (cleanDate(w) ?? '').slice(0, 4);
    years.set(year, (years.get(year) ?? 0) + 1);
  }
  const earlierYears = [...years.entries()]
    .map(([year, count]) => ({ year, count }))
    .sort((a, b) => b.year.localeCompare(a.year));
  return { today, buckets, earlierYears };
}

/** Works for one earlier-release year, newest first. Powers the lazy year endpoint. */
export async function getEarlierWorksForYear(
  db: D1Database,
  year: string,
  windowStart: string,
): Promise<CalendarWork[]> {
  if (!/^\d{4}$/.test(year)) return [];
  const { results } = await db
    .prepare(
      `SELECT id, title, kind, release_date, poster_url, slug
         FROM screen_works
        WHERE substr(release_date, 1, 4) = ?1
          AND (release_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
               OR release_date GLOB '[0-9][0-9][0-9][0-9]')
          AND CASE WHEN length(release_date) = 4
                   THEN release_date || '-01-01'
                   ELSE release_date END < ?2
        ORDER BY release_date DESC, title ASC`,
    )
    .bind(year, windowStart)
    .all<CalendarWork>();
  return results;
}

/** The recent-window start (YYYY-MM-DD) used to separate recent from earlier releases. */
export function recentWindowStart(today: string): string {
  return new Date(Date.parse(`${today}T00:00:00Z`) - RECENT_WINDOW_DAYS * DAY_MS)
    .toISOString()
    .slice(0, 10);
}
