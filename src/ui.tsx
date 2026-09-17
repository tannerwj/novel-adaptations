/** @jsxImportSource hono/jsx */
/**
 * src/ui.tsx — server-rendered UI for Novel Adaptations.
 *
 * Cinematic dark editorial theme. All visuals live in the CSS below; every
 * image render is guarded (conditional + onerror swap) so a missing or dead
 * URL can never produce a broken <img>.
 *
 * Interactions are dependency-free vanilla JS (vote buttons, shelf
 * selectors, the admin news queue). See USER_SCRIPT and QUEUE_SCRIPT.
 */
import type { Child } from 'hono/jsx';
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import type { AdaptationSummary, Book, NewsItem, NewsStatus, SourceRow } from './db';
import { ADAPTATION_STATUSES } from './db';
// Round 3 (SEO): per-page meta/OG/Twitter tags; no-op when origin is absent.
import { seoHead } from './seo';
import { FONT_FACE_CSS } from './spa/fonts';
// Round 4 (community): rating stars, spoiler-safe reviews, book-vs-screen
// polls, shareable-list controls.
import { RatingWidget } from './ratings/ui';
import type { RatingSummary } from './ratings/db';
import { ReviewsSection, type ReviewView } from './reviews/ui';
import { PollWidget } from './polls/ui';
import type { PollChoice, PollResults } from './polls/db';
import { AddToListControl } from './lists/ui';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * AdaptationSummary plus the screen-work poster (populated from
 * screen_works.poster_url by the db.ts SELECT). Kept as a named alias so
 * future poster-enrichment work has a stable type to hang onto.
 */
export type AdaptationWithPoster = AdaptationSummary;

export interface TimelineEvent {
  status: string;
  at: string | null;
  sourceUrl: string | null;
}

export interface PipelineRun {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  feedsOk: number;
  feedsFailed: number;
  itemsFetched: number;
  itemsNew: number;
  itemsSkippedCap: number;
  llmCalls: number;
  errors: string | null;
}

export type AuthUser = { email: string; isAdmin?: boolean } | null;

/**
 * Spread onto <a> tags that point at external URLs: opens in a new tab
 * without handing the new page access to window.opener.
 */
export const extLink = { target: '_blank', rel: 'noopener noreferrer' } as const;

// ---------------------------------------------------------------------------
// Theme — server-resolved, cookie-driven (Track A).
//
// The `theme` cookie ('light' | 'dark', default 'light') picks the palette.
// Layout renders <html data-theme={theme}> on the server, so the attribute
// is present in the SSR head and there is no flash of the wrong theme.
// Toggle via POST /api/theme (registered in src/index.tsx).
// ---------------------------------------------------------------------------

/** Theme names the CSS understands (`:root` = light, `[data-theme="dark"]`). */
export type ThemeName = 'light' | 'dark';

/** Cookie name carrying the user's theme choice (1-year Max-Age). */
import { THEME_COOKIE } from './theme';
export { THEME_COOKIE };

/** Read the theme for this request. Anything but 'dark' → 'light'. */
export function themeOf(c: Context): ThemeName {
  return getCookie(c, THEME_COOKIE) === 'dark' ? 'dark' : 'light';
}

/** Avatar initials from an email address, e.g. admin@example.com → "AD",
 *  tanner.wj@example.com → "TW". */
function initialsFor(email: string): string {
  const local = (email.split('@')[0] ?? '').trim();
  const parts = local.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  const initials =
    parts.length >= 2
      ? parts
          .slice(0, 2)
          .map((p) => p[0])
          .join('')
      : (parts[0] ?? local).slice(0, 2);
  return (initials || 'N').toUpperCase().slice(0, 2);
}

// ---------------------------------------------------------------------------
// Small helpers (labels)
// ---------------------------------------------------------------------------

export function statusLabel(status: string): string {
  return status.replace(/_/g, ' ');
}

function kindLabel(kind: string): string {
  return kind === 'film' ? 'Film' : 'Series';
}

function tierLabel(tier: string): string {
  return tier === 'rumor' ? 'Rumor' : tier;
}

function shelfLabel(shelf: string): string {
  switch (shelf) {
    case 'want_to_read':
      return 'Want to Read';
    case 'want_to_watch':
      return 'Want to Watch';
    case 'read':
      return 'Read';
    case 'watched':
      return 'Watched';
    default:
      return shelf.replace(/_/g, ' ');
  }
}

/** Deterministic hue from a string, for gradient placeholder art. */
function hueFor(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

/**
 * Status badge colors live in GLOBAL_CSS as `.status-badge.status-<status>`
 * rules with a `[data-theme="dark"]` override per status — never inline
 * styles. Every light/dark text color passes >= 4.5:1 on its surface
 * (the old single-hex map failed on light surfaces, e.g. #9aa4b2 ≈ 2.8:1
 * on white). Statuses missing from KNOWN_STATUSES fall back to the gray
 * `.status-unknown` treatment. Single source of truth: ADAPTATION_STATUSES
 * in db.ts — these derive from it so a new status can't drift out of sync.
 */
const KNOWN_STATUSES: ReadonlySet<string> = new Set(ADAPTATION_STATUSES);

/** The pipeline ladder (cancelled is a terminal side-branch, not a step). */
const PIPELINE: string[] = ADAPTATION_STATUSES.filter((s) => s !== 'cancelled');

// ---------------------------------------------------------------------------
// Global stylesheet — cinematic dark editorial theme
// ---------------------------------------------------------------------------

const GLOBAL_CSS = `
/* ------------------------------------------------------------------
 * Novel Adaptations theme — Linear/Stripe-quality restraint.
 *
 * Light theme is the default and lives in :root. Dark theme overrides sit
 * under [data-theme="dark"], which the server sets on <html> before any
 * paint (see Layout in this file), so there is no flash of the wrong
 * theme. The color-scheme property follows the theme so native form controls and
 * scrollbars match.
 *
 * THEME CONTRACT (for Track B and friends): every color on this page must
 * come from one of the --* tokens below. Legacy --gold/--gold-soft/--red/
 * --green/--blue are aliases of the new palette — prefer the new names in
 * new code.
 * ------------------------------------------------------------------ */
:root {
  color-scheme: light;

  /* --- surfaces --- */
  --bg: #faf9f6;
  --bg-soft: #f1eee6;
  --surface: #ffffff;
  --surface-2: #f4f1ea;
  --header-bg: rgba(250, 249, 246, .88);

  /* --- lines --- */
  --border: #e5dfd0;
  --border-strong: #cdc3ab;

  /* --- text (all pass >= 4.5:1 on --bg) --- */
  --text: #1e1c17;
  --muted: #5f594c;
  --faint: #6f695b;

  /* --- brand: gold/amber family --- */
  --accent: #c78f2e;        /* button fills, marks */
  --accent-soft: #eec25e;   /* hover on accent fills */
  --accent-ink: #14100a;    /* text on top of accent fills */
  --accent-deep: #8a5f14;   /* small text in accent color (>= 4.5:1 on --bg) */
  --accent-tint: #faf3dd;   /* pale gold wash for highlighted rows */

  /* --- functional --- */
  --link: #1a5fb4;
  --success: #2f7d44;
  --danger: #b3352f;
  --info: #2b6cb0;

  /* --- elevation --- */
  --shadow: 0 1px 2px rgba(30, 28, 23, .06), 0 12px 32px rgba(30, 28, 23, .08);
  --shadow-lg: 0 2px 4px rgba(30, 28, 23, .06), 0 24px 60px rgba(30, 28, 23, .14);

  --radius: 12px;

  /* legacy aliases — kept for older module CSS, prefer the names above */
  --gold: var(--accent);
  --gold-soft: var(--accent-soft);
  --red: var(--danger);
  --green: var(--success);
  --blue: var(--info);

  /* Fraunces for literary-cinematic display, Inter for clean body text.
     System stacks remain as zero-cost fallbacks. */
  --serif: 'Fraunces', Georgia, 'Times New Roman', serif;
  --sans: 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
}

[data-theme="dark"] {
  color-scheme: dark;

  --bg: #0b0c10;
  --bg-soft: #0e1016;
  --surface: #12141b;
  --surface-2: #171a23;
  --header-bg: rgba(11, 12, 16, .82);

  --border: #262b38;
  --border-strong: #3a4152;

  --text: #f1f2f5;
  --muted: #a9b1c2;   /* >= 4.5:1 on --bg */
  --faint: #8b93a6;   /* >= 4.5:1 on --bg, reads as secondary */

  --accent: #e3a83e;
  --accent-soft: #f0c368;
  --accent-ink: #14100a;
  --accent-deep: #e3a83e;
  --accent-tint: rgba(227, 168, 62, .1);

  --link: #8fc7ff;
  --success: #4caf6d;
  --danger: #e05252;
  --info: #4f9cf0;

  --shadow: 0 24px 60px rgba(0, 0, 0, .45);
  --shadow-lg: 0 24px 60px rgba(0, 0, 0, .6);
}

* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: var(--sans);
  background: var(--bg);
  background-image:
    radial-gradient(1200px 500px at 50% -10%, rgba(199, 143, 46, .06), transparent 60%),
    radial-gradient(900px 400px at 90% 0%, rgba(43, 108, 176, .05), transparent 60%);
  color: var(--text);
  line-height: 1.65;
  font-optical-sizing: auto; /* lets Fraunces tune itself at display sizes */
  min-height: 100vh;
  -webkit-font-smoothing: antialiased;
}
[data-theme="dark"] body {
  background-image:
    radial-gradient(1200px 500px at 50% -10%, rgba(227, 168, 62, .07), transparent 60%),
    radial-gradient(900px 400px at 90% 0%, rgba(79, 156, 240, .05), transparent 60%);
}
a { color: var(--link); text-decoration: none; }
a:hover { text-decoration: underline; }
::selection { background: rgba(199, 143, 46, .3); }
[data-theme="dark"] ::selection { background: rgba(227, 168, 62, .35); }

/* Visible keyboard focus everywhere — no-JS friendly, theme aware.
   The outline follows each element's own border-radius (pills stay pill-shaped). */
:focus-visible {
  outline: 2px solid var(--link);
  outline-offset: 2px;
}
/* Consistent, theme-aware focus ring for text-like controls. */
input[type="text"], input[type="email"], input[type="url"], input[type="number"],
input[type="search"], input[type="date"], textarea, select {
  accent-color: var(--accent);
}
input[type="text"]:focus-visible, input[type="email"]:focus-visible,
input[type="url"]:focus-visible, input[type="number"]:focus-visible,
input[type="search"]:focus-visible, input[type="date"]:focus-visible,
textarea:focus-visible, select:focus-visible {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-tint);
  outline: none;
}

/* ---- header / nav ---- */
.site-header {
  position: sticky; top: 0; z-index: 50;
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  background: var(--header-bg);
  border-bottom: 1px solid var(--border);
}
.site-header-inner {
  max-width: 1180px; margin: 0 auto; padding: .6rem 1.25rem;
  display: flex; align-items: center; gap: 1.25rem; flex-wrap: wrap;
}
.brand {
  font-family: var(--serif); font-size: 1.2rem; font-weight: 700;
  letter-spacing: -.01em; color: var(--text); white-space: nowrap;
}
.brand:hover { text-decoration: none; }
.brand .brand-arrow { color: var(--accent-deep); }
.main-nav { display: flex; gap: .1rem; flex-wrap: wrap; align-items: center; }
.main-nav a.nav-link {
  color: var(--muted); font-size: .87rem; font-weight: 600;
  padding: .42rem .8rem; border-radius: 999px;
}
.main-nav a.nav-link:hover { color: var(--text); text-decoration: none; background: var(--surface-2); }
.main-nav a.nav-link.active { color: var(--text); background: var(--surface-2); }
/* Header search — compact inline form. */
.header-search { display: flex; gap: .4rem; align-items: center; }
.header-search input[type="search"] {
  width: 10.5rem; padding: .42rem .85rem; font-size: .85rem;
  font-family: var(--sans); color: var(--text); background: var(--surface-2);
  border: 1px solid var(--border); border-radius: 999px;
}
.header-search input[type="search"]::placeholder { color: var(--faint); }
.header-search input[type="search"]:focus { border-color: var(--accent); outline: none; }
@media (max-width: 720px) { .header-search input[type="search"] { width: 7.5rem; } }
/* Right-hand cluster: theme toggle + user area. */
.header-actions { margin-left: auto; display: flex; align-items: center; gap: .6rem; }
.theme-form { display: inline-flex; margin: 0; }
.theme-toggle {
  display: inline-flex; align-items: center; justify-content: center;
  width: 2.1rem; height: 2.1rem; padding: 0; cursor: pointer;
  color: var(--muted); background: transparent;
  border: 1px solid var(--border); border-radius: 999px;
  transition: color .15s, border-color .15s, background .15s;
}
.theme-toggle:hover { color: var(--text); border-color: var(--border-strong); background: var(--surface-2); }
.theme-toggle svg { width: 1.05rem; height: 1.05rem; }
.header-user { display: flex; align-items: center; }
/* Avatar + account dropdown (vanilla JS toggle, no framework). */
.user-menu { position: relative; }
.avatar-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 2.1rem; height: 2.1rem; padding: 0; cursor: pointer;
  font: inherit; font-size: .8rem; font-weight: 700; letter-spacing: .03em;
  color: var(--accent-ink); background: var(--accent);
  border: 1px solid transparent; border-radius: 999px;
  transition: transform .15s, background .15s;
}
.avatar-btn:hover { background: var(--accent-soft); }
.avatar-btn:active { transform: scale(.96); }
.user-menu .menu {
  position: absolute; right: 0; top: calc(100% + .5rem);
  min-width: 13rem; padding: .4rem; margin: 0;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); box-shadow: var(--shadow-lg);
  z-index: 60;
}
.menu-item {
  display: block; width: 100%; text-align: left;
  font: inherit; font-size: .9rem; font-weight: 500; color: var(--text);
  padding: .55rem .8rem; border: 0; border-radius: 8px;
  background: transparent; cursor: pointer; text-decoration: none;
}
a.menu-item:hover, button.menu-item:hover { background: var(--surface-2); text-decoration: none; color: var(--text); }
.menu-divider { border: 0; border-top: 1px solid var(--border); margin: .4rem .2rem; }
.menu-label {
  font-size: .68rem; font-weight: 700; letter-spacing: .14em; text-transform: uppercase;
  color: var(--faint); margin: .45rem .8rem .2rem;
}
.menu-logout { margin: 0; }
.btn {
  font: inherit; font-size: .88rem; font-weight: 600; cursor: pointer;
  padding: .5rem 1rem; border-radius: 999px;
  border: 1px solid var(--border); background: var(--surface-2); color: var(--text);
  transition: border-color .15s, transform .15s;
}
.btn:hover { border-color: var(--accent); }
.btn:active { transform: scale(.97); }
.btn-primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.btn-primary:hover { background: var(--accent-soft); border-color: var(--accent-soft); }
/* Ghost: tertiary actions (move up/down, remove) — no chrome until hover. */
.btn-ghost { background: transparent; border-color: transparent; color: var(--muted); }
.btn-ghost:hover { background: var(--surface-2); border-color: transparent; color: var(--text); }
.btn-sm { font-size: .8rem; padding: .35rem .8rem; }
.btn[disabled] { opacity: .55; cursor: wait; }

/* ---- page shell ---- */
.page { max-width: 1180px; margin: 0 auto; padding: 2.5rem 1.25rem 4.5rem; }
.page-narrow { max-width: 760px; }
.kicker {
  text-transform: uppercase; letter-spacing: .22em; font-size: .72rem; font-weight: 700;
  color: var(--accent-deep); margin: 0 0 .5rem;
}
.display-title {
  font-family: var(--serif); font-weight: 700; line-height: 1.06;
  font-size: clamp(2.1rem, 5vw, 3.4rem); margin: 0 0 .8rem; letter-spacing: -.015em;
}
.lede { color: var(--muted); font-size: 1.06rem; max-width: 44rem; margin: 0 0 2.25rem; }
.section-title {
  font-family: var(--serif); font-size: 1.55rem; font-weight: 700; margin: 3rem 0 1.25rem;
  display: flex; align-items: baseline; gap: .75rem; letter-spacing: -.01em;
}
.section-title .count { font-family: var(--sans); font-size: .85rem; color: var(--faint); font-weight: 600; }
.meta { color: var(--muted); font-size: .9rem; }
.back-link { display: inline-block; margin-bottom: 1.25rem; color: var(--muted); font-size: .9rem; }
.back-link:hover { color: var(--text); }
.empty { color: var(--faint); padding: 3rem 1rem; text-align: center; font-size: 1.02rem; }
/* ---- poster cards ---- */
.poster-grid {
  display: grid; gap: 1.75rem 1.5rem;
  grid-template-columns: repeat(2, 1fr);
}
@media (min-width: 640px) { .poster-grid { grid-template-columns: repeat(3, 1fr); } }
@media (min-width: 960px) { .poster-grid { grid-template-columns: repeat(4, 1fr); } }
.poster-card { position: relative; }
.poster-card a.poster-link { display: block; border-radius: var(--radius); }
.poster {
  position: relative; aspect-ratio: 2 / 3; border-radius: var(--radius); overflow: hidden;
  background: var(--surface); border: 1px solid var(--border);
  transition: transform .25s ease, box-shadow .25s ease, border-color .25s ease;
}
.poster-card:hover .poster {
  transform: translateY(-6px);
  border-color: rgba(199, 143, 46, .55);
  box-shadow: var(--shadow-lg);
}
[data-theme="dark"] .poster-card:hover .poster { border-color: rgba(227, 168, 62, .55); }
.poster img {
  position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block;
}
.poster .art-fallback {
  position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: flex-end;
  padding: 1rem; gap: .35rem;
}
.poster .art-fallback .art-title {
  font-family: var(--serif); font-weight: 700; font-size: 1.25rem; line-height: 1.15; color: #fff;
  text-shadow: 0 2px 12px rgba(0, 0, 0, .6);
}
.poster .art-fallback .art-sub {
  font-size: .78rem; color: rgba(255, 255, 255, .75); text-transform: uppercase; letter-spacing: .14em;
}
.poster .art-fallback::after {
  content: ''; position: absolute; inset: 0;
  background: linear-gradient(to top, rgba(0, 0, 0, .55), transparent 55%);
  pointer-events: none;
}
.poster .art-fallback > * { position: relative; z-index: 1; }
.poster-card .card-body { padding: .8rem .15rem 0; }
.poster-card .card-title { font-size: 1.02rem; font-weight: 700; margin: 0 0 .2rem; line-height: 1.3; }
.poster-card .card-title a { color: var(--text); }
.poster-card .card-title a:hover { color: var(--accent-deep); text-decoration: none; }
.poster-card .card-meta { color: var(--muted); font-size: .85rem; margin: 0 0 .45rem; }
.poster-card .card-meta a { color: var(--muted); }
.poster-card .card-badges { display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; }

/* ---- badges ---- */
.status-badge, .tier-badge, .flag, .kind-pill {
  display: inline-block; font-size: .7rem; font-weight: 700;
  padding: .22rem .65rem; border-radius: 999px; border: 1px solid;
  text-transform: uppercase; letter-spacing: .06em; white-space: nowrap;
}
.tier-trusted { background: rgba(47, 125, 68, .12); color: #2f7d44; border-color: rgba(47, 125, 68, .4); }
.tier-reputable { background: rgba(43, 108, 176, .12); color: #2b6cb0; border-color: rgba(43, 108, 176, .4); }
.tier-rumor { background: rgba(179, 53, 47, .1); color: #b3352f; border-color: rgba(179, 53, 47, .4); }
.flag-review { background: rgba(199, 143, 46, .14); color: var(--accent-deep); border-color: rgba(199, 143, 46, .45); }
.flag-lowconf { background: rgba(111, 105, 91, .1); color: var(--muted); border-color: rgba(111, 105, 91, .35); }
.kind-pill { background: var(--surface-2); color: var(--muted); border-color: var(--border); }
[data-theme="dark"] .tier-trusted { background: rgba(76, 175, 109, .14); color: #5fd08a; border-color: rgba(76, 175, 109, .45); }
[data-theme="dark"] .tier-reputable { background: rgba(79, 156, 240, .14); color: #7db8f7; border-color: rgba(79, 156, 240, .45); }
[data-theme="dark"] .tier-rumor { background: rgba(224, 82, 82, .14); color: #ff8f8f; border-color: rgba(224, 82, 82, .5); }
[data-theme="dark"] .flag-review { background: rgba(227, 168, 62, .14); color: var(--accent-soft); border-color: rgba(227, 168, 62, .45); }
[data-theme="dark"] .flag-lowconf { background: rgba(154, 163, 181, .12); color: var(--muted); border-color: rgba(154, 163, 181, .35); }
[data-theme="dark"] .kind-pill { background: rgba(255, 255, 255, .06); color: var(--muted); border-color: var(--border); }
/* ---- status badges (book→screen pipeline) ----
 * Rendered by StatusBadge via .status-<status> classes so the dark-theme
 * override always applies. Every light/dark text color below was verified
 * >= 4.5:1 against its surface (#fff / #12141b); the pre-revamp single-hex
 * map (e.g. #9aa4b2 ≈ 2.8:1 on white) failed in light mode. */
.status-rumored { background: rgba(87, 98, 110, .1); color: #57626e; border-color: rgba(87, 98, 110, .4); }
.status-optioned { background: rgba(138, 95, 20, .1); color: #8a5f14; border-color: rgba(138, 95, 20, .4); }
.status-in_development { background: rgba(43, 108, 176, .1); color: #2b6cb0; border-color: rgba(43, 108, 176, .4); }
.status-filming { background: rgba(122, 63, 160, .1); color: #7a3fa0; border-color: rgba(122, 63, 160, .4); }
.status-post_production { background: rgba(179, 74, 31, .1); color: #b34a1f; border-color: rgba(179, 74, 31, .4); }
.status-released { background: rgba(47, 125, 68, .1); color: #2f7d44; border-color: rgba(47, 125, 68, .4); }
.status-cancelled { background: rgba(179, 53, 47, .1); color: #b3352f; border-color: rgba(179, 53, 47, .4); }
.status-unknown { background: rgba(87, 98, 110, .1); color: #57626e; border-color: rgba(87, 98, 110, .4); }
[data-theme="dark"] .status-rumored { background: rgba(154, 164, 178, .14); color: #9aa4b2; border-color: rgba(154, 164, 178, .45); }
[data-theme="dark"] .status-optioned { background: rgba(217, 164, 65, .14); color: #d9a441; border-color: rgba(217, 164, 65, .45); }
[data-theme="dark"] .status-in_development { background: rgba(79, 156, 240, .14); color: #4f9cf0; border-color: rgba(79, 156, 240, .45); }
[data-theme="dark"] .status-filming { background: rgba(160, 108, 213, .14); color: #a06cd5; border-color: rgba(160, 108, 213, .45); }
[data-theme="dark"] .status-post_production { background: rgba(224, 115, 79, .14); color: #e0734f; border-color: rgba(224, 115, 79, .45); }
[data-theme="dark"] .status-released { background: rgba(76, 175, 109, .14); color: #4caf6d; border-color: rgba(76, 175, 109, .45); }
[data-theme="dark"] .status-cancelled { background: rgba(224, 82, 82, .14); color: #e05252; border-color: rgba(224, 82, 82, .5); }
[data-theme="dark"] .status-unknown { background: rgba(154, 164, 178, .14); color: #9aa4b2; border-color: rgba(154, 164, 178, .45); }

/* ---- hero (detail pages) ---- */
.hero {
  display: grid; gap: 2rem; grid-template-columns: 1fr;
  margin-bottom: 2.5rem;
}
@media (min-width: 820px) { .hero { grid-template-columns: 300px 1fr; gap: 3rem; } }
.hero .poster { aspect-ratio: 2 / 3; max-width: 300px; box-shadow: var(--shadow-lg); }
.hero h1 { font-family: var(--serif); font-size: clamp(2.3rem, 5.5vw, 3.6rem); line-height: 1.04; margin: 0 0 .5rem; letter-spacing: -.015em; }
.hero .byline { color: var(--muted); font-size: 1.05rem; margin: 0 0 1.25rem; }
.hero .byline a { color: var(--text); }
.hero-badges { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: 1.5rem; }
.hero-actions { display: flex; flex-wrap: wrap; gap: .75rem; align-items: center; }
.hero-actions .votes-count { color: var(--muted); font-size: .9rem; font-weight: 600; }
select.shelf-select {
  font: inherit; font-size: .88rem; font-weight: 600; padding: .5rem .9rem;
  border-radius: 999px; border: 1px solid var(--border);
  background: var(--surface-2); color: var(--text); cursor: pointer;
}
select.shelf-select:hover { border-color: var(--accent); }

/* ---- detail sections ---- */
.detail-grid { display: grid; gap: 1.5rem; grid-template-columns: 1fr; }
@media (min-width: 900px) { .detail-grid.two { grid-template-columns: 1fr 1fr; } }
.panel {
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 1.5rem;
}
.panel h2 { font-family: var(--serif); font-size: 1.3rem; margin: 0 0 1rem; }
dl.facts { display: grid; grid-template-columns: 8.5rem 1fr; gap: .5rem 1rem; margin: 0; }
dl.facts dt { color: var(--faint); font-size: .82rem; text-transform: uppercase; letter-spacing: .08em; font-weight: 700; padding-top: .15rem; }
dl.facts dd { margin: 0; }
.news-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 1rem; }
.news-list li { border-bottom: 1px solid var(--border); padding-bottom: 1rem; }
.news-list li:last-child { border-bottom: 0; padding-bottom: 0; }
.news-list .news-title { font-weight: 700; font-size: 1rem; margin: 0 0 .25rem; }
.news-list .news-meta { color: var(--faint); font-size: .8rem; display: flex; gap: .6rem; flex-wrap: wrap; align-items: center; }

/* ---- status pipeline timeline ---- */
.timeline { margin: 1.5rem 0 0; }
.timeline ol {
  list-style: none; margin: 0; padding: 0;
  display: flex; flex-direction: column; gap: 0;
}
.timeline li { position: relative; padding: 0 0 1.6rem 2.4rem; }
.timeline li:last-child { padding-bottom: 0; }
.timeline li::before {
  content: ''; position: absolute; left: .72rem; top: 1.7rem; bottom: -.2rem;
  width: 2px; background: var(--border);
}
.timeline li:last-child::before { display: none; }
.timeline li.done::before { background: var(--success); opacity: .55; }
.timeline .dot {
  position: absolute; left: 0; top: .2rem; width: 1.6rem; height: 1.6rem; border-radius: 50%;
  border: 2px solid var(--border); background: var(--surface-2);
  display: flex; align-items: center; justify-content: center;
  font-size: .7rem; color: var(--faint);
}
.timeline li.done .dot { border-color: var(--success); background: var(--success); color: #fff; }
[data-theme="dark"] .timeline li.done .dot { background: rgba(76, 175, 109, .18); color: var(--success); }
.timeline li.current .dot {
  border-color: var(--accent); background: var(--accent-tint); color: var(--accent-deep);
  box-shadow: 0 0 0 5px rgba(199, 143, 46, .12);
  animation: pulse 2.2s ease-in-out infinite;
}
@keyframes pulse { 50% { box-shadow: 0 0 0 9px rgba(199, 143, 46, .05); } }
.timeline .step-label { font-weight: 700; font-size: .95rem; text-transform: capitalize; }
.timeline li.upcoming .step-label { color: var(--faint); font-weight: 600; }
.timeline li.current .step-label { color: var(--accent-deep); }
.timeline .step-meta { color: var(--faint); font-size: .82rem; margin-top: .15rem; }
.timeline .step-meta a { color: var(--link); font-size: .82rem; }
@media (min-width: 720px) {
  .timeline ol { flex-direction: row; align-items: flex-start; }
  .timeline li { flex: 1; padding: 2.2rem .6rem 0 0; min-width: 0; }
  .timeline li::before {
    left: 1.7rem; right: 0; top: .72rem; bottom: auto; width: auto; height: 2px;
  }
  .timeline .dot { left: 0; top: 0; }
}

/* ---- compact release notes (released adaptations) ---- */
.release-notes { margin: 1rem 0 0; }
.release-notes ol {
  list-style: none; margin: 0; padding: 0;
  display: flex; flex-wrap: wrap; gap: .75rem 2.25rem;
}
.release-notes li { display: flex; gap: .6rem; align-items: flex-start; }
.release-notes .dot {
  flex: none; width: 1.5rem; height: 1.5rem; border-radius: 50%;
  background: var(--success); color: #fff;
  display: flex; align-items: center; justify-content: center; font-size: .7rem;
}
[data-theme="dark"] .release-notes .dot { background: rgba(76, 175, 109, .18); color: var(--success); }
.release-notes .beat-label { font-weight: 700; font-size: .95rem; }
.release-notes .beat-meta { display: block; color: var(--faint); font-size: .82rem; margin-top: .15rem; }
.release-notes .beat-meta a { color: var(--link); font-size: .82rem; }

/* ---- leaderboard ---- */
.leaderboard { list-style: none; margin: 0; padding: 0; display: grid; gap: 1rem; }
.leaderboard li.rank-row {
  display: grid; grid-template-columns: 3.2rem 64px 1fr auto; gap: 1rem; align-items: center;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
  padding: .9rem 1.1rem;
  transition: border-color .2s;
}
.leaderboard li.rank-row:hover { border-color: var(--border-strong); }
.rank-num {
  font-family: var(--serif); font-size: 1.9rem; font-weight: 700; color: var(--faint); text-align: center;
}
li.rank-row:nth-child(1) .rank-num { color: var(--accent-deep); }
li.rank-row:nth-child(2) .rank-num { color: var(--faint); }
li.rank-row:nth-child(3) .rank-num { color: #a0672c; }
[data-theme="dark"] li.rank-row:nth-child(1) .rank-num { color: var(--accent); }
[data-theme="dark"] li.rank-row:nth-child(2) .rank-num { color: #c9cedb; }
[data-theme="dark"] li.rank-row:nth-child(3) .rank-num { color: #c98a4b; }
.rank-thumb { width: 64px; aspect-ratio: 2 / 3; border-radius: 8px; overflow: hidden; position: relative; background: var(--surface-2); border: 1px solid var(--border); }
.rank-thumb img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.rank-thumb .mini-art { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-family: var(--serif); font-weight: 700; font-size: 1.3rem; color: rgba(255, 255, 255, .9); }
.rank-info .rank-title { font-weight: 700; font-size: 1.05rem; margin: 0; }
.rank-info .rank-title a { color: var(--text); }
.rank-info .rank-authors { color: var(--muted); font-size: .88rem; margin: .1rem 0 0; }
.rank-votes { text-align: right; display: flex; flex-direction: column; gap: .45rem; align-items: flex-end; }
.rank-votes .votes { font-family: var(--serif); font-size: 1.4rem; font-weight: 700; }
.rank-votes .votes-label { font-size: .7rem; text-transform: uppercase; letter-spacing: .12em; color: var(--faint); }
.vote-btn.voted { border-color: var(--accent); background: var(--accent-tint); color: var(--accent-deep); }

/* ---- shelves ---- */
.shelf-group { margin-bottom: 2.5rem; }
.shelf-group > h2 { font-family: var(--serif); font-size: 1.4rem; margin: 0 0 1rem; }
.shelf-list { list-style: none; margin: 0; padding: 0; display: grid; gap: .75rem; }
.shelf-list li {
  display: flex; align-items: center; gap: 1rem;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
  padding: .8rem 1.1rem;
}
.shelf-list .shelf-kind { margin-left: auto; }

/* ---- auth ---- */
.auth-card {
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 2.5rem; max-width: 26rem; margin: 3rem auto;
  box-shadow: var(--shadow);
}
.auth-card h1 { font-family: var(--serif); font-size: 1.8rem; margin: 0 0 .5rem; }
.auth-card p { color: var(--muted); font-size: .95rem; }
.auth-card form { display: grid; gap: .9rem; margin-top: 1.5rem; }
.auth-card label { font-size: .85rem; font-weight: 600; color: var(--muted); }
.auth-card input[type="email"], .auth-card input[type="text"] {
  font: inherit; padding: .7rem 1rem; border-radius: 10px;
  border: 1px solid var(--border); background: var(--bg-soft); color: var(--text);
}
.auth-error {
  background: rgba(179, 53, 47, .08); border: 1px solid rgba(179, 53, 47, .5); color: var(--danger);
  border-radius: 10px; padding: .8rem 1rem; font-size: .9rem;
}
[data-theme="dark"] .auth-error { background: rgba(224, 82, 82, .12); color: #ff9d9d; }
.dev-link-box {
  background: var(--bg-soft); border: 1px dashed var(--border); border-radius: 10px;
  padding: 1rem; font-size: .85rem; word-break: break-all; margin-top: 1rem;
}

/* ---- feedback ---- */
.feedback-card {
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 2.5rem; max-width: 36rem; margin: 3rem auto;
  box-shadow: var(--shadow);
}
.feedback-card h1 { font-family: var(--serif); font-size: 1.8rem; margin: 0 0 .5rem; }
.feedback-card p { color: var(--muted); font-size: .95rem; }
.feedback-card form { display: grid; gap: 1rem; margin-top: 1.5rem; }
.feedback-card label { font-size: .85rem; font-weight: 600; color: var(--muted); display: grid; gap: .4rem; }
.feedback-card .hint { font-size: .78rem; color: var(--faint); font-weight: 400; }
.feedback-card input[type="email"], .feedback-card input[type="text"], .feedback-card input[type="url"],
.feedback-card select, .feedback-card textarea {
  font: inherit; padding: .7rem 1rem; border-radius: 10px;
  border: 1px solid var(--border); background: var(--bg-soft); color: var(--text);
  width: 100%; box-sizing: border-box;
}
.feedback-card textarea { min-height: 9rem; resize: vertical; }

/* ---- admin / queue ---- */
.tabs { display: flex; gap: .5rem; margin: 1.25rem 0 1.75rem; flex-wrap: wrap; }
.tabs a {
  padding: .5rem 1.1rem; border: 1px solid var(--border); border-radius: 999px;
  color: var(--muted); font-size: .88rem; font-weight: 600;
}
.tabs a:hover { color: var(--text); text-decoration: none; border-color: var(--accent); }
.tabs a.active { border-color: var(--accent); color: var(--text); background: var(--accent-tint); }
.queue-item {
  border: 1px solid var(--border); border-radius: var(--radius); padding: 1.4rem;
  background: var(--surface); margin-bottom: 1.1rem;
  transition: border-color .2s;
}
.queue-item:hover { border-color: var(--border-strong); }
.queue-item h3 { margin: 0 0 .5rem; font-size: 1.12rem; line-height: 1.35; }
.queue-item h3 a { color: var(--text); }
.queue-item h3 a:hover { color: var(--accent-deep); }
.queue-item .meta { color: var(--muted); font-size: .85rem; margin: .35rem 0; }
.queue-item .summary { font-size: .94rem; color: var(--text); opacity: .82; margin: .6rem 0; }
.queue-item .badges { display: flex; flex-wrap: wrap; gap: .4rem; margin: .4rem 0; }
.actions { display: flex; flex-wrap: wrap; gap: .6rem; margin-top: 1rem; align-items: center; }
.actions input[type="text"], .actions input[type="url"], .actions input[type="number"] {
  font: inherit; font-size: .85rem; padding: .5rem .8rem;
  border-radius: 10px; border: 1px solid var(--border);
  background: var(--bg-soft); color: var(--text); min-width: 0;
}
.actions select {
  font: inherit; font-size: .85rem; padding: .5rem .8rem;
  border-radius: 10px; border: 1px solid var(--border);
  background: var(--bg-soft); color: var(--text);
}
table.data { width: 100%; border-collapse: collapse; font-size: .86rem; margin-top: .75rem; }
table.data th, table.data td { text-align: left; padding: .55rem .7rem; border-bottom: 1px solid var(--border); }
table.data th { color: var(--faint); font-weight: 700; text-transform: uppercase; font-size: .72rem; letter-spacing: .08em; }
table.data tr.bad td { color: var(--danger); }
table.data tr.ok td:first-child { color: var(--text); }
.table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
.table-wrap table.data { margin-top: 0; }
.run-errors { max-width: 26rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--danger); }
.status-dot { display: inline-block; width: .55rem; height: .55rem; border-radius: 50%; margin-right: .45rem; vertical-align: baseline; }
.status-dot.ok { background: var(--success); }
.status-dot.err { background: var(--danger); }
.status-dot.run { background: var(--accent); animation: pulse 2s infinite; }
/* ---- search page ---- */
.search-form { display: flex; gap: .5rem; margin: 1.25rem 0 2rem; max-width: 32rem; }
.search-form input[type="search"] {
  flex: 1; min-width: 0; font: inherit; padding: .7rem 1rem; border-radius: 10px;
  border: 1px solid var(--border); background: var(--bg-soft); color: var(--text);
}
.search-form input[type="search"]::placeholder { color: var(--faint); }
.search-result-list { list-style: none; margin: 0; padding: 0; display: grid; gap: .75rem; }
.search-result-list > li > a:first-child { font-weight: 600; }
.search-result-list .sub { color: var(--muted); font-size: .88rem; }
.adapt-story { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem .75rem; }
/* ---- calendar page ---- */
.cal-group { margin-bottom: 1.5rem; }
.cal-month {
  font-family: var(--serif); font-size: 1.05rem; margin: 0 0 .75rem; color: var(--muted);
}
/* ---- footer ---- */
.site-footer { border-top: 1px solid var(--border); margin-top: 4rem; }
.site-footer-inner {
  max-width: 1180px; margin: 0 auto; padding: 2.5rem 1.25rem 2rem;
  color: var(--faint); font-size: .85rem;
  display: grid; gap: 2rem;
  grid-template-columns: 1fr;
}
@media (min-width: 720px) {
  .site-footer-inner { grid-template-columns: 1.4fr 1fr 1fr; }
}
.footer-brand p { margin: .5rem 0; color: var(--muted); font-size: .88rem; }
.footer-wordmark {
  font-family: var(--serif); font-size: 1.05rem; font-weight: 700; color: var(--text);
}
.footer-wordmark .brand-arrow { color: var(--accent-deep); }
.copyright { font-size: .8rem; }
.footer-heading {
  font-size: .72rem; font-weight: 700; text-transform: uppercase;
  letter-spacing: .14em; color: var(--text); margin: 0 0 .75rem;
}
.footer-links { list-style: none; margin: 0; padding: 0; display: grid; gap: .45rem; }
.footer-links a { color: var(--muted); }
.footer-links a:hover { color: var(--text); }
.footer-attribution {
  grid-column: 1 / -1; margin: .5rem 0 0; padding-top: 1.25rem;
  border-top: 1px solid var(--border); font-size: .78rem; color: var(--faint);
}
.footer-attribution a { color: inherit; text-decoration: underline; }
.footer-legal { font-size: .8rem; margin-top: -.25rem; }
.footer-legal a { color: var(--muted); }
.footer-legal a:hover { color: var(--text); }
/* Compact mobile footer (≤640px): brand + tagline, single legal line, the
 * Explore + Feedback link groups side-by-side in a 2-column grid. Mirrors
 * public/styles.css. */
@media (max-width: 640px) {
  .site-footer { margin-top: 2.5rem; }
  .site-footer-inner {
    grid-template-columns: 1fr 1fr;
    gap: 1.5rem 1.25rem;
    padding: 1.75rem 1.25rem 1.5rem;
  }
  .footer-brand { grid-column: 1 / -1; }
  .footer-brand p { margin: .3rem 0; }
  .footer-brand .copyright, .footer-brand .footer-legal { display: inline; }
  .footer-brand .copyright { margin-right: .6rem; }
  .footer-heading { margin: 0 0 .4rem; }
  .footer-links { gap: 0; }
  .footer-links a { padding: .55rem 0; }
  .footer-attribution { grid-column: 1 / -1; margin-top: 0; padding-top: 1rem; }
}
`;

// ---------------------------------------------------------------------------
// Layout — header nav + footer
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Layout — header nav + footer
// ---------------------------------------------------------------------------

export function Layout({
  title,
  children,
  user,
  origin,
  description,
  image,
  canonicalPath,
  theme,
}: {
  title: string;
  children: Child;
  user?: AuthUser;
  /** Request origin (`new URL(c.req.url).origin`) — enables SEO meta/OG tags. Absent → no SEO fragment. */
  origin?: string;
  description?: string;
  image?: string;
  /** Defaults to '/'; pass the request path for canonical URLs. Also the `next` target for the theme toggle. */
  canonicalPath?: string;
  /** Active theme ('light' default). Thread through via `theme={themeOf(c)}` —
      renders data-theme in the SSR head, so there is no flash of the wrong theme. */
  theme?: ThemeName;
}) {
  const activeTheme: ThemeName = theme ?? 'light';
  const nextPath = canonicalPath ?? '/';
  return (
    <html lang="en" data-theme={activeTheme}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title} — Novel Adaptations</title>
        {origin
          ? seoHead(origin, { title, description, image, path: canonicalPath ?? '/' })
          : null}
        <meta name="theme-color" content={activeTheme === 'dark' ? '#0b0c10' : '#faf9f6'} />
        <link rel="icon" type="image/png" href="/favicon.png" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        {/* Fraunces (literary-cinematic display) + Inter (clean body), self-hosted
            (public/fonts/, byte-identical to the Google Fonts latin subsets).
            Inlined @font-face replaces the render-blocking Google Fonts
            stylesheet; font-display: swap keeps text non-blocking. */}
        <style dangerouslySetInnerHTML={{ __html: FONT_FACE_CSS }} />
        <style dangerouslySetInnerHTML={{ __html: GLOBAL_CSS }} />
      </head>
      <body>
        <header class="site-header">
          <div class="site-header-inner">
            <a class="brand" href="/" aria-label="Novel Adaptations — home">
              <span class="brand-wordmark">Novel Adaptations</span><span class="brand-arrow">.</span>
            </a>
            <nav class="main-nav" aria-label="Primary">
              <a class="nav-link" href="/">Home</a>
              <a class="nav-link" href="/calendar">Calendar</a>
              <a class="nav-link" href="/most-wanted">Most Wanted</a>
              <a class="nav-link" href="/lists">Lists</a>
              <a class="nav-link" href="/shelves">Shelves</a>
            </nav>
            <form class="header-search" action="/search" method="get" role="search">
              <input
                type="search"
                name="q"
                placeholder="Search books, movies, shows…"
                aria-label="Search books, movies, and shows"
                maxlength={100}
              />
              <button class="btn btn-sm" type="submit">
                Search
              </button>
            </form>
            <div class="header-actions">
              <form class="theme-form" action="/api/theme" method="post">
                <input
                  type="hidden"
                  name="theme"
                  value={activeTheme === 'dark' ? 'light' : 'dark'}
                />
                <input type="hidden" name="next" value={nextPath} />
                <button
                  class="theme-toggle"
                  type="submit"
                  aria-label={activeTheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                  title={activeTheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                >
                  <span data-theme-icon="sun" hidden={activeTheme !== 'dark'}>
                    <SunIcon />
                  </span>
                  <span data-theme-icon="moon" hidden={activeTheme === 'dark'}>
                    <MoonIcon />
                  </span>
                </button>
              </form>
              <div class="header-user">
                {user?.email ? (
                  <div class="user-menu">
                    <button
                      class="avatar-btn"
                      type="button"
                      data-user-menu-btn
                      aria-haspopup="menu"
                      aria-expanded="false"
                      aria-controls="account-menu"
                      title={user.email}
                    >
                      {initialsFor(user.email)}
                    </button>
                    <div class="menu" id="account-menu" role="menu" data-user-menu hidden>
                      <a class="menu-item" role="menuitem" href="/shelves">Shelves</a>
                      <a class="menu-item" role="menuitem" href="/lists">My Lists</a>
                      <a class="menu-item" role="menuitem" href="/feedback">Feedback</a>
                      <hr class="menu-divider" />
                      {user.isAdmin ? (
                        <>
                          <p class="menu-label">Admin</p>
                          <a class="menu-item" role="menuitem" href="/admin/news">News curation</a>
                          <a class="menu-item" role="menuitem" href="/admin/feedback">Feedback triage</a>
                          <a class="menu-item" role="menuitem" href="/admin/screen-works">Screen works</a>
                          <hr class="menu-divider" />
                        </>
                      ) : null}
                      <form class="menu-logout" action="/auth/logout" method="post">
                        <button class="menu-item" role="menuitem" type="submit">Log out</button>
                      </form>
                    </div>
                  </div>
                ) : (
                  <a class="btn btn-sm" href="/auth/login">Log in</a>
                )}
              </div>
            </div>
          </div>
        </header>
        <main class="page">{children}</main>
        <footer class="site-footer">
          <div class="site-footer-inner">
            <div class="footer-brand">
              <span class="footer-wordmark">Novel Adaptations<span class="brand-arrow">.</span></span>
              <p>Tracking every book's journey to the screen.</p>
              <p class="copyright">© 2026 Novel Adaptations.</p>
              <p class="footer-legal"><a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></p>
            </div>
            <nav aria-label="Footer">
              <h2 class="footer-heading">Explore</h2>
              <ul class="footer-links">
                <li><a href="/">Home</a></li>
                <li><a href="/calendar">Calendar</a></li>
                <li><a href="/most-wanted">Most Wanted</a></li>
                <li><a href="/lists">Lists</a></li>
                <li><a href="/shelves">Shelves</a></li>
              </ul>
            </nav>
            <div>
              <h2 class="footer-heading">Feedback</h2>
              <ul class="footer-links">
                <li><a href="/feedback?type=feature">Suggest a feature</a></li>
                <li><a href="/feedback?type=adaptation_tip">Report an adaptation</a></li>
                <li><a href="/feedback?type=correction">Suggest a correction</a></li>
              </ul>
            </div>
            <p class="footer-attribution tmdb-attribution">
              This product uses the TMDB API but is not endorsed or certified by TMDB.
              Data and images via <a href="https://www.themoviedb.org/" {...extLink}>The Movie Database</a>.
            </p>
          </div>
        </footer>
        <script dangerouslySetInnerHTML={{ __html: MENU_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </body>
    </html>
  );
}

/** Sun glyph for the theme toggle (shown in dark mode → switches to light). */
function SunIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

/** Moon glyph for the theme toggle (shown in light mode → switches to dark). */
function MoonIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}

// Badges
// ---------------------------------------------------------------------------

export function StatusBadge({ status }: { status: string }) {
  const cls = KNOWN_STATUSES.has(status) ? `status-${status}` : 'status-unknown';
  return (
    <span class={`status-badge ${cls}`}>
      {statusLabel(status)}
    </span>
  );
}

export function TrustBadge({ tier }: { tier: string }) {
  return <span class={`tier-badge tier-${tier}`}>{tierLabel(tier)}</span>;
}

// ---------------------------------------------------------------------------
// Poster / cover art — never renders a broken <img>
// ---------------------------------------------------------------------------

/**
 * PosterArt renders either the image (on top of a gradient so there's no
 * layout flash) or a pure-CSS gradient placeholder carrying the title in
 * editorial serif type. The image is removed via onerror if the URL is
 * dead, revealing the gradient underneath — a broken <img> can never show.
 */
export function PosterArt({
  src,
  title,
  subtitle,
}: {
  src: string | null | undefined;
  title: string;
  subtitle?: string;
}) {
  const hue = hueFor(title);
  const gradient = `linear-gradient(135deg, hsl(${hue}, 48%, 22%), hsl(${(hue + 50) % 360}, 55%, 10%) 70%)`;
  const clean = src && src.trim() ? src.trim() : null;
  return (
    <div class="poster">
      <div class="art-fallback" style={`background:${gradient}`}>
        <div class="art-title">{title}</div>
        {subtitle && <div class="art-sub">{subtitle}</div>}
      </div>
      {clean && (
        <img
          src={clean}
          alt={`${title} artwork`}
          loading="lazy"
          onerror="this.remove()"
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// StatusTimeline — the development pipeline, visualized
// ---------------------------------------------------------------------------

/**
 * Compact "Release notes" for already-released adaptations. Renders only the
 * beats the data actually supports: dated timeline events, oldest first,
 * capped at 3 and anchored by the release itself. Nothing is invented — with
 * today's data that is a single "Released <date>" line.
 */
export function ReleaseNotes({
  events,
  releaseDate,
}: {
  events: TimelineEvent[];
  releaseDate: string | null;
}) {
  const rel = events.find((e) => e.status === 'released');
  const dated = events
    .filter((e) => e.at && e.status !== 'released')
    .sort((a, b) => String(a.at).localeCompare(String(b.at)))
    .slice(0, 2);
  const beats: { label: string; date: string | null; sourceUrl: string | null }[] =
    dated.map((e) => ({
      label: statusLabel(e.status),
      date: e.at,
      sourceUrl: e.sourceUrl,
    }));
  beats.push({
    label: 'Released',
    date: releaseDate ?? rel?.at ?? null,
    sourceUrl: rel?.sourceUrl ?? null,
  });
  return (
    <div class="release-notes">
      <ol>
        {beats.map((b) => (
          <li key={b.label + (b.date ?? '')}>
            <span class="dot" aria-hidden="true">
              ✓
            </span>
            <div class="beat">
              <span class="beat-label">{b.label}</span>
              <span class="beat-meta">
                {b.date ?? 'date unknown'}
                {b.sourceUrl && (
                  <>
                    {' · '}
                    <a href={b.sourceUrl} {...extLink}>
                      source
                    </a>
                  </>
                )}
              </span>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * Renders the rumored → … → released ladder. Each event maps onto a step:
 * steps at/before the last dated event are "done", the last dated event is
 * "current", later steps are "upcoming". A 'cancelled' event short-circuits
 * into a terminal state. Already-released adaptations get the compact
 * ReleaseNotes instead of the full ladder.
 */
export function StatusTimeline({
  events,
  released = false,
  releaseDate = null,
}: {
  events: TimelineEvent[];
  released?: boolean;
  releaseDate?: string | null;
}) {
  const cancelled = events.find((e) => e.status === 'cancelled');
  if (cancelled) {
    return (
      <div class="timeline">
        <ol>
          <li class="current">
            <span class="dot">✕</span>
            <div class="step-label">Cancelled</div>
            <div class="step-meta">
              {cancelled.at ?? 'date unknown'}
              {cancelled.sourceUrl && (
                <>
                  {' · '}
                  <a href={cancelled.sourceUrl} {...extLink}>source</a>
                </>
              )}
            </div>
          </li>
        </ol>
      </div>
    );
  }

  const byStatus = new Map<string, TimelineEvent>();
  for (const e of events) if (!byStatus.has(e.status)) byStatus.set(e.status, e);

  // Current = the latest pipeline step that has a date (or the last known
  // event if none is dated).
  let currentIdx = -1;
  PIPELINE.forEach((s, i) => {
    const e = byStatus.get(s);
    if (e && e.at) currentIdx = i;
  });
  if (currentIdx === -1) {
    const last = events[events.length - 1];
    if (last) currentIdx = PIPELINE.indexOf(last.status);
  }

  return (
    <div class="timeline">
      <ol>
        {PIPELINE.map((s, i) => {
          const e = byStatus.get(s);
          const state = i < currentIdx ? 'done' : i === currentIdx ? 'current' : 'upcoming';
          return (
            <li class={state} key={s}>
              <span class="dot" aria-hidden="true">{state === 'done' ? '✓' : ''}</span>
              <div class="step-label">{statusLabel(s)}</div>
              <div class="step-meta">
                {e?.at ?? '—'}
                {e?.sourceUrl && (
                  <>
                    {' · '}
                    <a href={e.sourceUrl} {...extLink}>source</a>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Vanilla JS — votes & shelves (dependency-free, no framework)
// ---------------------------------------------------------------------------

/**
 * MENU_SCRIPT wires the header account dropdown: toggles aria-expanded,
 * closes on outside click and on Escape (returning focus to the button).
 * Rendered by Layout on every page so the menu works without any framework.
 */
const MENU_SCRIPT = `
(function () {
  var btn = document.querySelector('[data-user-menu-btn]');
  var menu = document.querySelector('[data-user-menu]');
  if (!btn || !menu) return;
  function open() { menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); }
  function close() { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
  btn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (menu.hidden) open(); else close();
  });
  document.addEventListener('click', function (e) {
    if (!menu.hidden && !menu.contains(e.target) && !btn.contains(e.target)) close();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !menu.hidden) { close(); btn.focus(); }
  });
})();
`;

/**
 * THEME_SCRIPT makes the header theme toggle instant: it intercepts the
 * `.theme-form` submit, sends it via fetch, and flips `data-theme` on
 * `<html>` without a page reload. If the fetch fails (or JS is disabled),
 * the plain form POST still works as the progressive-enhancement fallback.
 */
const THEME_SCRIPT = `
(function () {
  var DARK_META = '#0b0c10';
  var LIGHT_META = '#faf9f6';
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form || form.nodeName !== 'FORM' || !form.classList.contains('theme-form')) return;
    e.preventDefault();
    var data = new FormData(form);
    fetch(form.action, {
      method: 'POST',
      body: data,
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json' }
    }).then(
      function (res) { return res.json(); },
      function () { return null; }
    ).then(function (json) {
      if (json && (json.theme === 'dark' || json.theme === 'light')) {
        applyTheme(form, json.theme);
      } else {
        form.submit(); // server didn't speak JSON — fall back to the plain POST
      }
    });
  });
  function applyTheme(form, next) {
    document.documentElement.setAttribute('data-theme', next);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', next === 'dark' ? DARK_META : LIGHT_META);
    var input = form.querySelector('input[name="theme"]');
    if (input) input.value = next === 'dark' ? 'light' : 'dark';
    var sun = form.querySelector('[data-theme-icon="sun"]');
    var moon = form.querySelector('[data-theme-icon="moon"]');
    if (sun) sun.hidden = next !== 'dark';
    if (moon) moon.hidden = next === 'dark';
    var btn = form.querySelector('.theme-toggle');
    if (btn) {
      var label = next === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
      btn.setAttribute('aria-label', label);
      btn.setAttribute('title', label);
    }
  }
})();
`;

/**
 * USER_SCRIPT wires:
 *  - [data-vote-btn] (books only): POST /api/votes { bookId } to vote,
 *    DELETE /api/votes/:bookId to unvote. Toggles .voted, the label, and the
 *    sibling [data-vote-count-for="book-<id>"] count.
 *  - select[data-shelf-select]: POST /api/shelves { targetType, targetId, shelf };
 *    empty value → DELETE /api/shelves { targetType, targetId }.
 * Anonymous users are sent to /auth/login.
 */
const USER_SCRIPT = `
(function () {
  function redirectToLogin() { window.location.href = '/auth/login'; }
  async function reqJson(path, opts) {
    var init = { headers: { 'Content-Type': 'application/json' } };
    if (opts) for (var k in opts) init[k] = opts[k];
    const res = await fetch(path, init);
    let data = {};
    try { data = await res.json(); } catch (e) {}
    return { ok: res.ok, status: res.status, data };
  }
  function bad(res) {
    if (res.status === 401 || res.status === 403) { redirectToLogin(); return true; }
    if (res.status === 429) alert('Slow down — you get 20 votes per day.');
    else alert('Something went wrong. Please try again.');
    return true;
  }

  document.querySelectorAll('[data-vote-btn]').forEach(function (btn) {
    btn.addEventListener('click', async function () {
      if (btn.getAttribute('data-authed') !== '1') { redirectToLogin(); return; }
      var bookId = Number(btn.getAttribute('data-target-id'));
      var voted = btn.classList.contains('voted');
      var label = btn.querySelector('.vote-label');
      if (label && !btn.hasAttribute('data-label-orig')) {
        btn.setAttribute('data-label-orig', label.textContent || '');
      }
      btn.disabled = true;
      var r = voted
        ? await reqJson('/api/votes/' + bookId, { method: 'DELETE' })
        : await reqJson('/api/votes', { method: 'POST', body: JSON.stringify({ bookId: bookId }) });
      btn.disabled = false;
      if (!r.ok) { bad(r); return; }
      var countEl = document.querySelector('[data-vote-count-for="book-' + bookId + '"]');
      if (typeof r.data.votes === 'number' && countEl) countEl.textContent = r.data.votes;
      btn.classList.toggle('voted', !voted);
      btn.setAttribute('aria-pressed', String(!voted));
      if (label) {
        label.textContent = !voted ? 'Voted ✓' : (btn.getAttribute('data-label-orig') || 'Vote');
      }
    });
  });

  document.querySelectorAll('select[data-shelf-select]').forEach(function (sel) {
    sel.addEventListener('change', async function () {
      if (sel.getAttribute('data-authed') !== '1') { redirectToLogin(); return; }
      var body = {
        targetType: sel.getAttribute('data-target-type'),
        targetId: Number(sel.getAttribute('data-target-id')),
      };
      var shelf = sel.value || null;
      var r = shelf
        ? await reqJson('/api/shelves', { method: 'POST', body: JSON.stringify({ targetType: body.targetType, targetId: body.targetId, shelf: shelf }) })
        : await reqJson('/api/shelves', { method: 'DELETE', body: JSON.stringify(body) });
      if (!r.ok) { bad(r); }
    });
  });
})();
`;

/** Shared shelf picker. userShelf null/undefined → "add to shelf" empty state. */
function ShelfPicker({
  targetType,
  targetId,
  userShelf,
  authed,
}: {
  targetType: 'book' | 'adaptation';
  targetId: number;
  userShelf: string | null | undefined;
  authed: boolean;
}) {
  return (
    <select
      class="shelf-select"
      data-shelf-select
      data-authed={authed ? '1' : '0'}
      data-target-type={targetType}
      data-target-id={String(targetId)}
      title="Add to a shelf"
      aria-label="Add to a shelf"
    >
      <option value="">＋ Shelf…</option>
      {(['want_to_read', 'read', 'want_to_watch', 'watched'] as const).map((s) => (
        <option value={s} selected={userShelf === s} key={s}>
          {userShelf === s ? '✓ ' : ''}{shelfLabel(s)}
        </option>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------------------
// HomePage — poster-card grid
// ---------------------------------------------------------------------------

function AdaptationCard({ a }: { a: AdaptationWithPoster }) {
  return (
    <article class="poster-card">
      <a class="poster-link" href={`/watch/${a.screen_slug ?? a.screen_work_id}`} aria-label={`${a.screen_title} — the screen work`}>
        <PosterArt
          src={a.screen_poster_url ?? a.book_cover_url}
          title={a.screen_title}
          subtitle={`${kindLabel(a.screen_kind)} · ${a.book_authors}`}
        />
      </a>
      <div class="card-body">
        <h2 class="card-title">
          <a href={`/adaptations/${a.adaptation_slug ?? a.id}`}>{a.screen_title}</a>
        </h2>
        <p class="card-meta">
          from <a href={`/books/${a.book_slug ?? a.book_id}`}>{a.book_title}</a> by {a.book_authors}
        </p>
        <div class="card-badges">
          <span class="kind-pill">{kindLabel(a.screen_kind)}</span>
          <StatusBadge status={a.status} />
        </div>
      </div>
    </article>
  );
}

export function HomePage({
  adaptations,
  user,
  origin,
  theme,
}: {
  adaptations: AdaptationSummary[];
  user?: AuthUser;
  origin?: string;
  theme?: ThemeName;
}) {
  return (
    <Layout title="Browse" user={user} origin={origin} canonicalPath="/" theme={theme}>
      <p class="kicker">The adaptation tracker</p>
      <h1 class="display-title">Every book's journey to the screen.</h1>
      <p class="lede">
        Follow novels as they're optioned, filmed, and released as movies and
        series.
      </p>
      {adaptations.length === 0 ? (
        <p class="empty">No adaptations tracked yet. Check back soon.</p>
      ) : (
        <div class="poster-grid">
          {adaptations.map((a) => (
            <AdaptationCard a={a} key={a.id} />
          ))}
        </div>
      )}
    </Layout>
  );
}

// ---------------------------------------------------------------------------
// AdaptationPage
// ---------------------------------------------------------------------------

export function AdaptationPage({
  adaptation,
  timeline,
  userVoted,
  userShelf,
  pollResults,
  pollChoice,
  user,
  news,
  origin,
  canonicalPath,
  theme,
}: {
  adaptation: AdaptationWithPoster;
  timeline?: TimelineEvent[];
  userVoted?: boolean;
  userShelf?: string | null;
  pollResults?: PollResults;
  pollChoice?: PollChoice | null;
  user?: AuthUser;
  news?: NewsItem[];
  origin?: string;
  canonicalPath?: string;
  theme?: ThemeName;
}) {
  const authed = !!user?.email;
  const targetType = 'adaptation' as const;
  return (
    <Layout
      title={adaptation.screen_title}
      user={user}
      origin={origin}
      canonicalPath={canonicalPath}
      theme={theme}
      description={`Follow ${adaptation.book_title} by ${adaptation.book_authors} from page to screen — adaptation status, timeline, and news.`}
      image={adaptation.screen_poster_url ?? adaptation.book_cover_url ?? undefined}
    >
      <a class="back-link" href="/">← All adaptations</a>
      <div class="hero">
        <PosterArt
          src={adaptation.screen_poster_url ?? adaptation.book_cover_url}
          title={adaptation.screen_title}
          subtitle={`${kindLabel(adaptation.screen_kind)} adaptation`}
        />
        <div>
          <p class="kicker">{kindLabel(adaptation.screen_kind)} adaptation</p>
          <h1>{adaptation.screen_title}</h1>
          <p class="byline">
            Based on <a href={`/books/${adaptation.book_slug ?? adaptation.book_id}`}><em>{adaptation.book_title}</em></a>
            {' '}by {adaptation.book_authors}
          </p>
          <div class="hero-badges">
            <StatusBadge status={adaptation.status} />
            {adaptation.screen_release_date && (
              <span class="kind-pill">📅 {adaptation.screen_release_date}</span>
            )}
          </div>
          <div class="hero-actions">
            <button
              type="button"
              class={`btn ${userVoted ? 'voted vote-btn' : 'vote-btn'}`}
              data-vote-btn
              data-authed={authed ? '1' : '0'}
              data-target-type="book"
              data-target-id={String(adaptation.book_id)}
              aria-pressed={userVoted ? 'true' : 'false'}
            >
              <span class="vote-label">{userVoted ? 'Voted ✓' : 'Vote: adapt this'}</span>
            </button>
            <ShelfPicker
              targetType={targetType}
              targetId={adaptation.id}
              userShelf={userShelf}
              authed={authed}
            />
            {!authed && <span class="meta">Log in to vote and shelve.</span>}
          </div>
          {adaptation.status === 'released' && (
            <h2 class="section-title" style="margin-top:1.5rem">Release notes</h2>
          )}
          <StatusTimeline
            events={timeline ?? [{ status: adaptation.status, at: null, sourceUrl: adaptation.source_url }]}
            released={adaptation.status === 'released'}
            releaseDate={adaptation.screen_release_date}
          />
          <p class="meta" style="margin-top:1rem">
            <a href={`/feedback?type=correction&subject=${encodeURIComponent(adaptation.screen_title)}`}>Suggest a correction</a>
          </p>
        </div>
      </div>

      <div class="detail-grid two">
        <section class="panel">
          <h2>The book</h2>
          <dl class="facts">
            <dt>Title</dt>
            <dd>
              <a href={`/books/${adaptation.book_slug ?? adaptation.book_id}`}>{adaptation.book_title}</a>
            </dd>
            <dt>Authors</dt>
            <dd>{adaptation.book_authors}</dd>
          </dl>
        </section>
        <section class="panel">
          <h2>The screen work</h2>
          <dl class="facts">
            <dt>Title</dt>
            <dd>
              <a href={`/watch/${adaptation.screen_slug ?? adaptation.screen_work_id}`}>{adaptation.screen_title}</a>
            </dd>
            <dt>Kind</dt>
            <dd>{kindLabel(adaptation.screen_kind)}</dd>
            <dt>Release</dt>
            <dd>{adaptation.screen_release_date ?? 'TBA'}</dd>
          </dl>
        </section>
      </div>

      <section class="panel" style="margin-top:1.5rem">
        <PollWidget
          adaptationId={adaptation.id}
          counts={pollResults?.counts ?? { book: 0, screen: 0, both: 0, undecided: 0 }}
          total={pollResults?.total ?? 0}
          userChoice={pollChoice ?? null}
          signedIn={authed}
          art={{
            bookCoverUrl: adaptation.book_cover_url ?? null,
            bookTitle: adaptation.book_title,
            screenPosterUrl: adaptation.screen_poster_url ?? null,
            screenTitle: adaptation.screen_title,
          }}
        />
      </section>

      <div class="detail-grid" style="margin-top:1.5rem">
        <section class="panel">
          <h2>Adaptation status</h2>
          <dl class="facts">
            <dt>Status</dt>
            <dd>
              <StatusBadge status={adaptation.status} />
            </dd>
            <dt>Source</dt>
            <dd>
              {adaptation.source_url ? (
                <a href={adaptation.source_url} {...extLink}>source link ↗</a>
              ) : (
                '—'
              )}
            </dd>
          </dl>
        </section>
      </div>

      {news !== undefined && (
        <section>
          <h2 class="section-title">
            Latest news <span class="count">{news.length}</span>
          </h2>
          {news.length === 0 ? (
            <p class="meta">No news yet for this title.</p>
          ) : (
            <ul class="news-list panel">
              {news.map((n) => (
                <li key={n.id}>
                  <p class="news-title">
                    <a href={n.url} {...extLink}>{n.title}</a>
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
      )}

      <script dangerouslySetInnerHTML={{ __html: USER_SCRIPT }} />
    </Layout>
  );
}

// ---------------------------------------------------------------------------
// BookPage
// ---------------------------------------------------------------------------

export function BookPage({
  book,
  adaptations,
  userVoted,
  userShelf,
  ratingSummary,
  userRating,
  reviews,
  userId,
  userLists,
  user,
  origin,
  canonicalPath,
  theme,
}: {
  book: Book;
  adaptations: AdaptationSummary[];
  userVoted?: boolean;
  userShelf?: string | null;
  ratingSummary?: RatingSummary;
  userRating?: number | null;
  reviews?: ReviewView[];
  userId?: number | null;
  userLists?: { id: number; title: string }[];
  user?: AuthUser;
  origin?: string;
  canonicalPath?: string;
  theme?: ThemeName;
}) {
  const authed = !!user?.email;
  const correctionHref = `/feedback?type=correction&subject=${encodeURIComponent(book.title)}`;
  return (
    <Layout
      title={book.title}
      user={user}
      origin={origin}
      canonicalPath={canonicalPath}
      theme={theme}
      description={`Follow ${book.title} by ${book.authors} from page to screen — adaptation status, release dates, and news.`}
      image={book.cover_url ?? undefined}
    >
      <a class="back-link" href="/">← All adaptations</a>
      <div class="hero">
        <PosterArt src={book.cover_url} title={book.title} subtitle={book.authors} />
        <div>
          <p class="kicker">The book</p>
          <h1>{book.title}</h1>
          <p class="byline">by {book.authors}</p>
          <div class="hero-actions">
            <button
              type="button"
              class={`btn ${userVoted ? 'voted vote-btn' : 'vote-btn'}`}
              data-vote-btn
              data-authed={authed ? '1' : '0'}
              data-target-type="book"
              data-target-id={String(book.id)}
              aria-pressed={userVoted ? 'true' : 'false'}
            >
              <span class="vote-label">{userVoted ? 'Voted ✓' : 'Vote: adapt this'}</span>
            </button>
            <ShelfPicker
              targetType="book"
              targetId={book.id}
              userShelf={userShelf}
              authed={authed}
            />
            <RatingWidget
              targetType="book"
              targetId={book.id}
              average={ratingSummary?.average ?? 0}
              count={ratingSummary?.count ?? 0}
              userRating={userRating ?? null}
              signedIn={authed}
            />
            <AddToListControl
              targetType="book"
              targetId={book.id}
              userLists={userLists ?? []}
              signedIn={authed}
            />
            {!authed && <span class="meta">Log in to vote and shelve.</span>}
          </div>
          <p class="meta" style="margin-top:1rem">
            <a href={correctionHref}>Suggest a correction</a>
          </p>
        </div>
      </div>

      <div class="detail-grid">
        <section class="panel">
          <h2>Details</h2>
          <dl class="facts">
            <dt>Published</dt>
            <dd>{book.pub_date ?? '—'}</dd>
            <dt>ISBN</dt>
            <dd>{book.isbn ?? '—'}</dd>
          </dl>
        </section>
      </div>

      <section>
        <h2 class="section-title">
          Adaptations <span class="count">{adaptations.length}</span>
        </h2>
        {adaptations.length === 0 ? (
          <p class="meta">No screen adaptations tracked yet — but the vote button above says it all.</p>
        ) : (
          <div class="poster-grid">
            {adaptations.map((a) => (
              <AdaptationCard a={a} key={a.id} />
            ))}
          </div>
        )}
      </section>

      <ReviewsSection
        targetType="book"
        targetId={book.id}
        reviews={reviews ?? []}
        currentUserId={userId ?? null}
      />

      <script dangerouslySetInnerHTML={{ __html: USER_SCRIPT }} />
    </Layout>
  );
}

// ---------------------------------------------------------------------------
// MostWantedPage — ranked leaderboard
// ---------------------------------------------------------------------------

export function MostWantedPage({
  items,
  user,
  origin,
  theme,
}: {
  items: {
    book: { id: number; title: string; authors: string; coverUrl: string | null };
    votes: number;
    userVoted: boolean;
  }[];
  user: AuthUser;
  origin?: string;
  theme?: ThemeName;
}) {
  const authed = !!user?.email;
  return (
    <Layout title="Most Wanted" user={user} origin={origin} canonicalPath="/most-wanted" theme={theme}>
      <p class="kicker">Community leaderboard</p>
      <h1 class="display-title">Most Wanted Adaptations</h1>
      <p class="lede">
        The books readers most want to see on screen. One vote per person
        {authed ? '.' : ' — log in to add yours.'}
      </p>
      {items.length === 0 ? (
        <p class="empty">No votes yet. Be the first.</p>
      ) : (
        <ol class="leaderboard">
          {items.map((item, i) => {
            const b = item.book;
            const hue = hueFor(b.title);
            const gradient = `linear-gradient(135deg, hsl(${hue}, 48%, 24%), hsl(${(hue + 50) % 360}, 55%, 12%))`;
            const clean = b.coverUrl && b.coverUrl.trim() ? b.coverUrl.trim() : null;
            return (
              <li class="rank-row" key={b.id}>
                <div class="rank-num" aria-label={`Rank ${i + 1}`}>{i + 1}</div>
                <div class="rank-thumb">
                  <div class="mini-art" style={`background:${gradient}`}>
                    {b.title.charAt(0)}
                  </div>
                  {clean && (
                    <img src={clean} alt="" loading="lazy" onerror="this.remove()" />
                  )}
                </div>
                <div class="rank-info">
                  <p class="rank-title">
                    <a href={`/books/${b.id}`}>{b.title}</a>
                  </p>
                  <p class="rank-authors">{b.authors}</p>
                </div>
                <div class="rank-votes">
                  <div>
                    <div class="votes" data-vote-count-for={`book-${b.id}`}>{item.votes}</div>
                    <div class="votes-label">votes</div>
                  </div>
                  <button
                    type="button"
                    class={`btn btn-sm ${item.userVoted ? 'voted vote-btn' : 'vote-btn'}`}
                    data-vote-btn
                    data-authed={authed ? '1' : '0'}
                    data-target-type="book"
                    data-target-id={String(b.id)}
                    aria-pressed={item.userVoted ? 'true' : 'false'}
                  >
                    <span class="vote-label">{item.userVoted ? 'Voted ✓' : 'Vote'}</span>
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <script dangerouslySetInnerHTML={{ __html: USER_SCRIPT }} />
    </Layout>
  );
}

// ---------------------------------------------------------------------------
// ShelvesPage — grouped by shelf
// ---------------------------------------------------------------------------

const SHELF_ORDER = ['want_to_read', 'read', 'want_to_watch', 'watched'] as const;

/** Section headings for the ShelvesPage groups (nicer than the raw labels). */
const SHELF_SECTION_TITLES: Record<string, string> = {
  want_to_read: 'Reading',
  read: 'Read',
  want_to_watch: 'Watchlist',
  watched: 'Watched',
};

export function ShelvesPage({
  shelves,
  user,
  theme,
}: {
  shelves: {
    targetType: 'book' | 'adaptation';
    targetId: number;
    title: string;
    shelf: string;
  }[];
  user: { email: string; isAdmin?: boolean };
  theme?: ThemeName;
}) {
  const grouped = new Map<string, typeof shelves>();
  for (const s of shelves) {
    const arr = grouped.get(s.shelf) ?? [];
    arr.push(s);
    grouped.set(s.shelf, arr);
  }
  const ordered = [...SHELF_ORDER.filter((s) => grouped.has(s)), ...[...grouped.keys()].filter((k) => !(SHELF_ORDER as readonly string[]).includes(k))];
  return (
    <Layout title="My shelves" user={user} theme={theme}>
      <p class="kicker">Your collection</p>
      <h1 class="display-title">Shelves</h1>
      <p class="lede">Everything you've shelved — reading, read, watchlist, and watched.</p>
      {shelves.length === 0 ? (
        <p class="empty">
          Your shelves are empty. Browse <a href="/">adaptations</a> and shelve something.
        </p>
      ) : (
        ordered.map((shelf) => (
          <section class="shelf-group" key={shelf}>
            <h2>
              {SHELF_SECTION_TITLES[shelf] ?? shelfLabel(shelf)}{' '}
              <span class="count">({grouped.get(shelf)?.length ?? 0})</span>
            </h2>
            <ul class="shelf-list">
              {(grouped.get(shelf) ?? []).map((s) => (
                <li key={`${s.targetType}-${s.targetId}`}>
                  <span>
                    <a href={s.targetType === 'book' ? `/books/${s.targetId}` : `/adaptations/${s.targetId}`}>
                      {s.title}
                    </a>
                  </span>
                  <span class="shelf-kind kind-pill">
                    {s.targetType === 'book' ? '📚 Book' : '🎬 Adaptation'}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </Layout>
  );
}

// ---------------------------------------------------------------------------
// Auth pages
// ---------------------------------------------------------------------------

export function LoginPage({ error, theme }: { error?: string; theme?: ThemeName }) {
  return (
    <Layout title="Log in" theme={theme}>
      <div class="auth-card">
        <p class="kicker">Welcome back</p>
        <h1>Log in</h1>
        <p>Enter your email and we'll send you a magic sign-in link. No passwords, ever.</p>
        {error && <div class="auth-error">{error}</div>}
        <form action="/auth/magic-link" method="post">
          <label for="email">Email address</label>
          <input type="email" id="email" name="email" required autocomplete="email" placeholder="you@example.com" />
          <button class="btn btn-primary" type="submit">Send magic link</button>
        </form>
      </div>
    </Layout>
  );
}

export function MagicLinkSentPage({
  email,
  devLink,
  theme,
}: {
  email: string;
  devLink?: string;
  theme?: ThemeName;
}) {
  return (
    <Layout title="Check your email" theme={theme}>
      <div class="auth-card">
        <p class="kicker">Almost there</p>
        <h1>Check your inbox</h1>
        <p>
          We sent a sign-in link to <strong>{email}</strong>. It expires soon —
          click it to finish logging in.
        </p>
        {devLink && (
          <div class="dev-link-box">
            <strong>Dev mode:</strong> no email was sent. Use this link instead:
            <br />
            <a href={devLink}>{devLink}</a>
          </div>
        )}
      </div>
    </Layout>
  );
}

export function AuthErrorPage({ message, theme }: { message: string; theme?: ThemeName }) {
  return (
    <Layout title="Sign-in problem" theme={theme}>
      <div class="auth-card">
        <p class="kicker">Hmm</p>
        <h1>Couldn't sign you in</h1>
        <div class="auth-error">{message}</div>
        <p style="margin-top:1.5rem">
          <a href="/auth/login">Try again →</a>
        </p>
      </div>
    </Layout>
  );
}

// ---------------------------------------------------------------------------
// NewsQueuePage — owner curation queue (same props & behavior, restyled)
// ---------------------------------------------------------------------------

const QUEUE_STATUSES: NewsStatus[] = ['pending', 'approved', 'dismissed'];
/** Promote dropdown options — mirrors ADAPTATION_STATUSES (db.ts). */
const PROMOTE_STATUSES: readonly string[] = ADAPTATION_STATUSES;

/**
 * QUEUE_SCRIPT — interaction contract:
 *  - buttons with [data-act] POST JSON to their data-path (plus optional
 *    { reason } from the enclosing form), then reload the page;
 *  - forms.promote-form POST { adaptation_id, status?, corroborating_url? }
 *    on submit, then reload.
 * Auth rides the httpOnly session cookie (same-origin fetch) — no key
 * parameter is threaded through links or sent in headers.
 */
const QUEUE_SCRIPT = `
async function callApi(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) { alert('Error: ' + (data.error || res.status)); return; }
  location.reload();
}
document.querySelectorAll('button[data-act]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const form = btn.closest('form');
    let body = {};
    if (form) {
      const fd = new FormData(form);
      const reason = String(fd.get('reason') || '').trim();
      if (reason) body = { reason };
    }
    callApi(btn.getAttribute('data-path'), body);
  });
});
document.querySelectorAll('form.promote-form').forEach((form) => {
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const body = { adaptation_id: Number(fd.get('adaptation_id')) };
    const st = String(fd.get('status') || '');
    if (st) body.status = st;
    const cu = String(fd.get('corroborating_url') || '').trim();
    if (cu) body.corroborating_url = cu;
    if (!body.adaptation_id) { alert('Enter an adaptation id.'); return; }
    callApi(form.getAttribute('data-path'), body);
  });
});
`;

/** Shared feed-health table, used by NewsQueuePage and PipelineRunsPage. */
export function FeedHealthTable({ sources }: { sources: SourceRow[] }) {
  if (sources.length === 0) {
    return <p class="meta">No feed runs recorded yet — the next scheduled run populates this.</p>;
  }
  return (
    <div class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th>Feed</th>
            <th>Tier</th>
            <th>Active</th>
            <th>Last fetched</th>
            <th>Status</th>
            <th>Failures</th>
          </tr>
        </thead>
        <tbody>
          {sources.map((s) => (
            <tr class={s.is_active === 0 || s.consecutive_failures > 0 ? 'bad' : 'ok'} key={s.name}>
              <td>{s.name}</td>
              <td>
                <TrustBadge tier={s.trust_tier} />
              </td>
              <td>{s.is_active === 1 ? 'yes' : 'PAUSED'}</td>
              <td>{s.last_fetched_at ?? '—'}</td>
              <td>{s.last_status ?? '—'}</td>
              <td>{s.consecutive_failures}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function NewsQueuePage({
  status,
  items,
  sources,
  counts,
  theme,
}: {
  status: NewsStatus;
  items: NewsItem[];
  sources: SourceRow[];
  counts: Record<NewsStatus, number>;
  theme?: ThemeName;
}) {
  return (
    <Layout title="News curation" theme={theme}>
      <p class="kicker">Owner console</p>
      <h1 class="display-title">News curation</h1>
      <p class="lede">
        The news pipeline proposes; you dispose. Sorted by trust tier, then
        confidence. <a href="/admin/news/runs">View pipeline runs →</a>
      </p>
      <nav class="tabs" aria-label="Queue status">
        {QUEUE_STATUSES.map((s) => (
          <a href={`/admin/news?status=${s}`} class={s === status ? 'active' : ''} key={s}>
            {s} ({counts[s] ?? 0})
          </a>
        ))}
      </nav>

      {items.length === 0 ? (
        <p class="empty">Nothing here. The queue is clear. 🎬</p>
      ) : (
        items.map((item) => (
          <article class="queue-item" key={item.id}>
            <h3>
              <a href={item.url} {...extLink}>
                {item.title}
              </a>
            </h3>
            <div class="badges">
              <TrustBadge tier={item.trust_tier} />
              {item.needs_review === 1 && <span class="flag flag-review">needs review</span>}
              {(item.confidence ?? 0) < 0.5 && <span class="flag flag-lowconf">low confidence</span>}
            </div>
            <p class="meta">
              {item.source}
              {item.published_at ? ` · ${item.published_at}` : ''} · confidence{' '}
              {Math.round((item.confidence ?? 0) * 100)}%
              {item.llm_model ? ` · ${item.llm_model.replace('@cf/meta/', '')}` : ''}
            </p>
            {(item.book_title || item.author || item.status_signal) && (
              <p class="meta">
                {item.book_title && (
                  <>
                    Book: <strong>{item.book_title}</strong>
                  </>
                )}
                {item.author && <> by {item.author}</>}
                {item.screen_kind && item.screen_kind !== 'unknown' && <> · {item.screen_kind}</>}
                {item.status_signal && item.status_signal !== 'none' && (
                  <> · signal: {item.status_signal}</>
                )}
              </p>
            )}
            {item.summary && <p class="summary">{item.summary}</p>}
            {status === 'pending' && (
              <div class="actions">
                <button type="button" class="btn btn-sm" data-act="approve" data-path={`/api/news/${item.id}/approve`}>
                  Approve
                </button>
                <form data-path={`/api/news/${item.id}/dismiss`} style="display:contents">
                  <input type="text" name="reason" placeholder="dismiss reason (optional)" />
                  <button type="button" class="btn btn-sm" data-act="dismiss" data-path={`/api/news/${item.id}/dismiss`}>
                    Dismiss
                  </button>
                </form>
                <form
                  class="promote-form"
                  data-path={`/api/news/${item.id}/promote`}
                  style="display:contents"
                >
                  <input
                    type="number"
                    name="adaptation_id"
                    min="1"
                    placeholder="adaptation id"
                    style="width:8rem"
                  />
                  <select name="status" title="explicit status (default: one step forward)">
                    <option value="">auto: next step</option>
                    {PROMOTE_STATUSES.map((s) => (
                      <option value={s} key={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                  <input
                    type="url"
                    name="corroborating_url"
                    placeholder={
                      item.trust_tier === 'rumor'
                        ? 'corroborating URL (required for rumors)'
                        : 'corroborating URL (optional)'
                    }
                    style="width:14rem"
                  />
                  <button type="submit" class="btn btn-sm btn-primary">
                    Promote
                  </button>
                </form>
              </div>
            )}
          </article>
        ))
      )}

      <h2 class="section-title">Feed health</h2>
      <FeedHealthTable sources={sources} />

      <script dangerouslySetInnerHTML={{ __html: QUEUE_SCRIPT }} />
    </Layout>
  );
}

// ---------------------------------------------------------------------------
// PipelineRunsPage — recent ingestion runs + feed health (Track A data)
// ---------------------------------------------------------------------------

export function PipelineRunsPage({
  runs,
  sources,
  theme,
}: {
  runs: PipelineRun[];
  sources: SourceRow[];
  theme?: ThemeName;
}) {
  return (
    <Layout title="Pipeline runs" theme={theme}>
      <p class="kicker">Owner console</p>
      <h1 class="display-title">Pipeline runs</h1>
      <p class="lede">
        Recent news-ingestion runs: what the pipeline fetched, classified, and
        queued — and where it stumbled.
      </p>

      <h2 class="section-title">
        Recent runs <span class="count">{runs.length}</span>
      </h2>
      {runs.length === 0 ? (
        <p class="empty">No runs recorded yet. The first scheduled run will appear here.</p>
      ) : (
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr>
                <th>#</th>
                <th>Started</th>
                <th>Finished</th>
                <th>Status</th>
                <th>Feeds ok</th>
                <th>Feeds failed</th>
                <th>Fetched</th>
                <th>New</th>
                <th>Skipped (cap)</th>
                <th>LLM calls</th>
                <th>Errors</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr class={r.status === 'error' || r.status === 'failed' ? 'bad' : 'ok'} key={r.id}>
                  <td>{r.id}</td>
                  <td>{r.startedAt}</td>
                  <td>{r.finishedAt ?? '—'}</td>
                  <td>
                    <span class={`status-dot ${r.status === 'ok' ? 'ok' : r.status === 'running' ? 'run' : 'err'}`} />
                    {r.status}
                  </td>
                  <td>{r.feedsOk}</td>
                  <td>{r.feedsFailed}</td>
                  <td>{r.itemsFetched}</td>
                  <td>{r.itemsNew}</td>
                  <td>{r.itemsSkippedCap}</td>
                  <td>{r.llmCalls}</td>
                  <td class="run-errors" title={r.errors ?? ''}>{r.errors ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 class="section-title">Feed health</h2>
      <FeedHealthTable sources={sources} />
    </Layout>
  );
}
