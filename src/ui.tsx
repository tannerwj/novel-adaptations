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
import type { AdaptationSummary, Book, NewsItem, NewsStatus, SourceRow } from './db';

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

export type AuthUser = { email: string } | null;

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
    case 'done':
      return 'Done';
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

const STATUS_COLORS: Record<string, string> = {
  rumored: '#9aa4b2',
  optioned: '#d9a441',
  in_development: '#4f9cf0',
  filming: '#a06cd5',
  post_production: '#e0734f',
  released: '#4caf6d',
  cancelled: '#e05252',
};

/** The pipeline ladder (cancelled is a terminal side-branch, not a step). */
const PIPELINE: string[] = [
  'rumored',
  'optioned',
  'in_development',
  'filming',
  'post_production',
  'released',
];

// ---------------------------------------------------------------------------
// Global stylesheet — cinematic dark editorial theme
// ---------------------------------------------------------------------------

const GLOBAL_CSS = `
:root {
  color-scheme: dark;
  --bg: #0a0b0f;
  --bg-soft: #0e1016;
  --surface: #12141b;
  --surface-2: #171a23;
  --border: #262b38;
  --text: #f2f3f6;
  --muted: #9aa3b5;
  --faint: #6b7284;
  --gold: #e3a83e;
  --gold-soft: #f0c368;
  --red: #e05252;
  --green: #4caf6d;
  --blue: #4f9cf0;
  --link: #8fc7ff;
  --serif: Georgia, 'Times New Roman', serif;
  --sans: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  --radius: 12px;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: var(--sans);
  background: var(--bg);
  background-image:
    radial-gradient(1200px 500px at 50% -10%, rgba(227,168,62,.07), transparent 60%),
    radial-gradient(900px 400px at 90% 0%, rgba(79,156,240,.05), transparent 60%);
  color: var(--text);
  line-height: 1.6;
  min-height: 100vh;
  -webkit-font-smoothing: antialiased;
}
a { color: var(--link); text-decoration: none; }
a:hover { text-decoration: underline; }
::selection { background: rgba(227,168,62,.35); }

/* ---- header / nav ---- */
.site-header {
  position: sticky; top: 0; z-index: 50;
  backdrop-filter: blur(14px);
  background: rgba(10,11,15,.82);
  border-bottom: 1px solid var(--border);
}
.site-header-inner {
  max-width: 1180px; margin: 0 auto; padding: .8rem 1.25rem;
  display: flex; align-items: center; gap: 1.5rem; flex-wrap: wrap;
}
.brand {
  font-family: var(--serif); font-size: 1.4rem; font-weight: 700;
  letter-spacing: .01em; color: #fff; white-space: nowrap;
}
.brand:hover { text-decoration: none; }
.brand .brand-arrow { color: var(--gold); }
.brand .brand-tag { display:block; font-family: var(--sans); font-size:.68rem; font-weight:600; letter-spacing:.28em; text-transform:uppercase; color: var(--muted); }
.main-nav { display: flex; gap: .25rem; flex-wrap: wrap; align-items: center; }
.main-nav a.nav-link {
  color: var(--muted); font-size: .92rem; font-weight: 600;
  padding: .45rem .85rem; border-radius: 999px;
}
.main-nav a.nav-link:hover { color: #fff; text-decoration: none; background: var(--surface-2); }
.main-nav a.nav-link.active { color: #fff; background: var(--surface-2); }
.header-user { margin-left: auto; display: flex; align-items: center; gap: .75rem; }
.header-user .email { color: var(--muted); font-size: .85rem; max-width: 14rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.logout-form { display: inline; }
.btn {
  font: inherit; font-size: .88rem; font-weight: 600; cursor: pointer;
  padding: .5rem 1rem; border-radius: 999px;
  border: 1px solid var(--border); background: var(--surface-2); color: var(--text);
  transition: border-color .15s, transform .15s;
}
.btn:hover { border-color: var(--gold); }
.btn:active { transform: scale(.97); }
.btn-primary { background: var(--gold); border-color: var(--gold); color: #14100a; }
.btn-primary:hover { background: var(--gold-soft); border-color: var(--gold-soft); }
.btn-sm { font-size: .8rem; padding: .35rem .8rem; }

/* ---- page shell ---- */
.page { max-width: 1180px; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
.page-narrow { max-width: 760px; }
.kicker {
  text-transform: uppercase; letter-spacing: .22em; font-size: .72rem; font-weight: 700;
  color: var(--gold); margin: 0 0 .5rem;
}
.display-title {
  font-family: var(--serif); font-weight: 700; line-height: 1.08;
  font-size: clamp(2rem, 5vw, 3.4rem); margin: 0 0 .75rem; letter-spacing: -.01em;
}
.lede { color: var(--muted); font-size: 1.05rem; max-width: 44rem; margin: 0 0 2rem; }
.section-title {
  font-family: var(--serif); font-size: 1.5rem; font-weight: 700; margin: 2.75rem 0 1.25rem;
  display: flex; align-items: baseline; gap: .75rem;
}
.section-title .count { font-family: var(--sans); font-size: .85rem; color: var(--faint); font-weight: 600; }
.meta { color: var(--muted); font-size: .9rem; }
.back-link { display: inline-block; margin-bottom: 1.25rem; color: var(--muted); font-size: .9rem; }
.back-link:hover { color: #fff; }
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
  border-color: rgba(227,168,62,.55);
  box-shadow: 0 18px 44px rgba(0,0,0,.55), 0 0 0 1px rgba(227,168,62,.25);
}
.poster img {
  position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block;
}
.poster .art-fallback {
  position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: flex-end;
  padding: 1rem; gap: .35rem;
}
.poster .art-fallback .art-title {
  font-family: var(--serif); font-weight: 700; font-size: 1.25rem; line-height: 1.15; color: #fff;
  text-shadow: 0 2px 12px rgba(0,0,0,.6);
}
.poster .art-fallback .art-sub {
  font-size: .78rem; color: rgba(255,255,255,.75); text-transform: uppercase; letter-spacing: .14em;
}
.poster .art-fallback::after {
  content: ''; position: absolute; inset: 0;
  background: linear-gradient(to top, rgba(0,0,0,.55), transparent 55%);
  pointer-events: none;
}
.poster .art-fallback > * { position: relative; z-index: 1; }
.poster-card .card-body { padding: .8rem .15rem 0; }
.poster-card .card-title { font-size: 1.02rem; font-weight: 700; margin: 0 0 .2rem; line-height: 1.3; }
.poster-card .card-title a { color: var(--text); }
.poster-card .card-title a:hover { color: var(--gold-soft); text-decoration: none; }
.poster-card .card-meta { color: var(--muted); font-size: .85rem; margin: 0 0 .45rem; }
.poster-card .card-meta a { color: var(--muted); }
.poster-card .card-badges { display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; }

/* ---- badges ---- */
.status-badge, .tier-badge, .flag, .kind-pill {
  display: inline-block; font-size: .7rem; font-weight: 700;
  padding: .22rem .65rem; border-radius: 999px; border: 1px solid;
  text-transform: uppercase; letter-spacing: .06em; white-space: nowrap;
}
.tier-trusted { background: rgba(76,175,109,.14); color: #5fd08a; border-color: rgba(76,175,109,.45); }
.tier-reputable { background: rgba(79,156,240,.14); color: #7db8f7; border-color: rgba(79,156,240,.45); }
.tier-rumor { background: rgba(224,82,82,.14); color: #ff8f8f; border-color: rgba(224,82,82,.5); }
.flag-review { background: rgba(227,168,62,.14); color: var(--gold-soft); border-color: rgba(227,168,62,.45); }
.flag-lowconf { background: rgba(154,163,181,.12); color: var(--muted); border-color: rgba(154,163,181,.35); }
.kind-pill { background: rgba(255,255,255,.06); color: var(--muted); border-color: var(--border); }

/* ---- hero (detail pages) ---- */
.hero {
  display: grid; gap: 2rem; grid-template-columns: 1fr;
  margin-bottom: 2.5rem;
}
@media (min-width: 820px) { .hero { grid-template-columns: 300px 1fr; gap: 3rem; } }
.hero .poster { aspect-ratio: 2 / 3; max-width: 300px; box-shadow: 0 24px 60px rgba(0,0,0,.6); }
.hero h1 { font-family: var(--serif); font-size: clamp(2.2rem, 5.5vw, 3.6rem); line-height: 1.05; margin: 0 0 .5rem; letter-spacing: -.01em; }
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
.timeline li.done::before { background: rgba(76,175,109,.5); }
.timeline .dot {
  position: absolute; left: 0; top: .2rem; width: 1.6rem; height: 1.6rem; border-radius: 50%;
  border: 2px solid var(--border); background: var(--surface-2);
  display: flex; align-items: center; justify-content: center;
  font-size: .7rem; color: var(--faint);
}
.timeline li.done .dot { border-color: var(--green); background: rgba(76,175,109,.18); color: var(--green); }
.timeline li.current .dot {
  border-color: var(--gold); background: rgba(227,168,62,.22); color: var(--gold);
  box-shadow: 0 0 0 5px rgba(227,168,62,.12);
  animation: pulse 2.2s ease-in-out infinite;
}
@keyframes pulse { 50% { box-shadow: 0 0 0 9px rgba(227,168,62,.05); } }
.timeline .step-label { font-weight: 700; font-size: .95rem; text-transform: capitalize; }
.timeline li.upcoming .step-label { color: var(--faint); font-weight: 600; }
.timeline li.current .step-label { color: var(--gold-soft); }
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

/* ---- leaderboard ---- */
.leaderboard { list-style: none; margin: 0; padding: 0; display: grid; gap: 1rem; }
.leaderboard li.rank-row {
  display: grid; grid-template-columns: 3.2rem 64px 1fr auto; gap: 1rem; align-items: center;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
  padding: .9rem 1.1rem;
  transition: border-color .2s;
}
.leaderboard li.rank-row:hover { border-color: rgba(227,168,62,.4); }
.rank-num {
  font-family: var(--serif); font-size: 1.9rem; font-weight: 700; color: var(--faint); text-align: center;
}
li.rank-row:nth-child(1) .rank-num { color: var(--gold); }
li.rank-row:nth-child(2) .rank-num { color: #c9cedb; }
li.rank-row:nth-child(3) .rank-num { color: #c98a4b; }
.rank-thumb { width: 64px; aspect-ratio: 2 / 3; border-radius: 8px; overflow: hidden; position: relative; background: var(--surface-2); border: 1px solid var(--border); }
.rank-thumb img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.rank-thumb .mini-art { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-family: var(--serif); font-weight: 700; font-size: 1.3rem; color: rgba(255,255,255,.9); }
.rank-info .rank-title { font-weight: 700; font-size: 1.05rem; margin: 0; }
.rank-info .rank-title a { color: var(--text); }
.rank-info .rank-authors { color: var(--muted); font-size: .88rem; margin: .1rem 0 0; }
.rank-votes { text-align: right; display: flex; flex-direction: column; gap: .45rem; align-items: flex-end; }
.rank-votes .votes { font-family: var(--serif); font-size: 1.4rem; font-weight: 700; }
.rank-votes .votes-label { font-size: .7rem; text-transform: uppercase; letter-spacing: .12em; color: var(--faint); }
.vote-btn.voted { border-color: var(--gold); background: rgba(227,168,62,.16); color: var(--gold-soft); }

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
  box-shadow: 0 24px 60px rgba(0,0,0,.45);
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
  background: rgba(224,82,82,.12); border: 1px solid rgba(224,82,82,.5); color: #ff9d9d;
  border-radius: 10px; padding: .8rem 1rem; font-size: .9rem;
}
.dev-link-box {
  background: var(--bg-soft); border: 1px dashed var(--border); border-radius: 10px;
  padding: 1rem; font-size: .85rem; word-break: break-all; margin-top: 1rem;
}

/* ---- admin / queue ---- */
.tabs { display: flex; gap: .5rem; margin: 1.25rem 0 1.75rem; flex-wrap: wrap; }
.tabs a {
  padding: .5rem 1.1rem; border: 1px solid var(--border); border-radius: 999px;
  color: var(--muted); font-size: .88rem; font-weight: 600;
}
.tabs a:hover { color: #fff; text-decoration: none; border-color: var(--gold); }
.tabs a.active { border-color: var(--gold); color: #fff; background: rgba(227,168,62,.1); }
.queue-item {
  border: 1px solid var(--border); border-radius: var(--radius); padding: 1.4rem;
  background: var(--surface); margin-bottom: 1.1rem;
  transition: border-color .2s;
}
.queue-item:hover { border-color: #3a4152; }
.queue-item h3 { margin: 0 0 .5rem; font-size: 1.12rem; line-height: 1.35; }
.queue-item h3 a { color: var(--text); }
.queue-item h3 a:hover { color: var(--gold-soft); }
.queue-item .meta { color: var(--muted); font-size: .85rem; margin: .35rem 0; }
.queue-item .summary { font-size: .94rem; color: #c9cdd6; margin: .6rem 0; }
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
table.data tr.bad td { color: #ff8f8f; }
table.data tr.ok td:first-child { color: var(--text); }
.table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
.table-wrap table.data { margin-top: 0; }
.run-errors { max-width: 26rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #ff8f8f; }
.status-dot { display: inline-block; width: .55rem; height: .55rem; border-radius: 50%; margin-right: .45rem; vertical-align: baseline; }
.status-dot.ok { background: var(--green); }
.status-dot.err { background: var(--red); }
.status-dot.run { background: var(--gold); animation: pulse 2s infinite; }

/* ---- footer ---- */
.site-footer { border-top: 1px solid var(--border); margin-top: 4rem; }
.site-footer-inner {
  max-width: 1180px; margin: 0 auto; padding: 2rem 1.25rem;
  color: var(--faint); font-size: .85rem;
  display: flex; gap: 1rem; flex-wrap: wrap; justify-content: space-between; align-items: baseline;
}
`;

// ---------------------------------------------------------------------------
// Layout — header nav + footer
// ---------------------------------------------------------------------------

export function Layout({
  title,
  children,
  user,
}: {
  title: string;
  children: Child;
  user?: { email: string } | null;
}) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title} — Novel Adaptations</title>
        <style>{GLOBAL_CSS}</style>
      </head>
      <body>
        <header class="site-header">
          <div class="site-header-inner">
            <a class="brand" href="/">
              Novel Adaptations<span class="brand-arrow">.</span>
              <span class="brand-tag">books → screen</span>
            </a>
            <nav class="main-nav" aria-label="Primary">
              <a class="nav-link" href="/">Browse</a>
              <a class="nav-link" href="/most-wanted">Most Wanted</a>
              <a class="nav-link" href="/shelves">Shelves</a>
              <a class="nav-link" href="/admin/news">News curation</a>
            </nav>
            <div class="header-user">
              {user?.email ? (
                <>
                  <span class="email" title={user.email}>{user.email}</span>
                  <form class="logout-form" action="/auth/logout" method="post">
                    <button class="btn btn-sm" type="submit">Log out</button>
                  </form>
                </>
              ) : (
                <a class="btn btn-sm" href="/auth/login">Log in</a>
              )}
            </div>
          </div>
        </header>
        <main class="page">{children}</main>
        <footer class="site-footer">
          <div class="site-footer-inner">
            <span>Novel Adaptations — tracking every book's journey to the screen.</span>
            <span>
              <a href="/docs/DESIGN.md">Design doc</a>
            </span>
          </div>
        </footer>
      </body>
    </html>
  );
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

export function StatusBadge({ status }: { status: string }) {
  const color = STATUS_COLORS[status] ?? '#9aa4b2';
  return (
    <span class="status-badge" style={`background:${color}1f;color:${color};border-color:${color}66`}>
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
 * Renders the rumored → … → released ladder. Each event maps onto a step:
 * steps at/before the last dated event are "done", the last dated event is
 * "current", later steps are "upcoming". A 'cancelled' event short-circuits
 * into a terminal state.
 */
export function StatusTimeline({ events }: { events: TimelineEvent[] }) {
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
                  <a href={cancelled.sourceUrl} rel="noopener noreferrer">source</a>
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
                    <a href={e.sourceUrl} rel="noopener noreferrer">source</a>
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
      {(['want_to_read', 'want_to_watch', 'done'] as const).map((s) => (
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
      <a class="poster-link" href={`/adaptations/${a.id}`} aria-label={`${a.book_title} adaptation`}>
        <PosterArt
          src={a.screen_poster_url ?? a.book_cover_url}
          title={a.screen_title}
          subtitle={`${kindLabel(a.screen_kind)} · ${a.book_authors}`}
        />
      </a>
      <div class="card-body">
        <h2 class="card-title">
          <a href={`/adaptations/${a.id}`}>{a.screen_title}</a>
        </h2>
        <p class="card-meta">
          from <a href={`/books/${a.book_id}`}>{a.book_title}</a> by {a.book_authors}
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
}: {
  adaptations: AdaptationSummary[];
  user?: AuthUser;
}) {
  return (
    <Layout title="Browse" user={user}>
      <p class="kicker">The adaptation tracker</p>
      <h1 class="display-title">Every book's journey to the screen.</h1>
      <p class="lede">
        From whispered rumors to opening night — follow novels as they're
        optioned, filmed, and released as movies and series.
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
  user,
  news,
}: {
  adaptation: AdaptationWithPoster;
  timeline?: TimelineEvent[];
  userVoted?: boolean;
  userShelf?: string | null;
  user?: AuthUser;
  news?: NewsItem[];
}) {
  const authed = !!user?.email;
  const targetType = 'adaptation' as const;
  return (
    <Layout title={adaptation.screen_title} user={user}>
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
            Based on <a href={`/books/${adaptation.book_id}`}><em>{adaptation.book_title}</em></a>
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
          <StatusTimeline events={timeline ?? [{ status: adaptation.status, at: null, sourceUrl: adaptation.source_url }]} />
        </div>
      </div>

      <div class="detail-grid two">
        <section class="panel">
          <h2>The book</h2>
          <dl class="facts">
            <dt>Title</dt>
            <dd>
              <a href={`/books/${adaptation.book_id}`}>{adaptation.book_title}</a>
            </dd>
            <dt>Authors</dt>
            <dd>{adaptation.book_authors}</dd>
          </dl>
        </section>
        <section class="panel">
          <h2>The screen work</h2>
          <dl class="facts">
            <dt>Title</dt>
            <dd>{adaptation.screen_title}</dd>
            <dt>Kind</dt>
            <dd>{kindLabel(adaptation.screen_kind)}</dd>
            <dt>Release</dt>
            <dd>{adaptation.screen_release_date ?? 'TBA'}</dd>
          </dl>
        </section>
      </div>

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
                <a href={adaptation.source_url} rel="noopener noreferrer">source link ↗</a>
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
                    <a href={n.url} rel="noopener noreferrer">{n.title}</a>
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
  user,
}: {
  book: Book;
  adaptations: AdaptationSummary[];
  userVoted?: boolean;
  userShelf?: string | null;
  user?: AuthUser;
}) {
  const authed = !!user?.email;
  return (
    <Layout title={book.title} user={user}>
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
            {!authed && <span class="meta">Log in to vote and shelve.</span>}
          </div>
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
}: {
  items: {
    book: { id: number; title: string; authors: string; coverUrl: string | null };
    votes: number;
    userVoted: boolean;
  }[];
  user: AuthUser;
}) {
  const authed = !!user?.email;
  return (
    <Layout title="Most Wanted" user={user}>
      <p class="kicker">Community leaderboard</p>
      <h1 class="display-title">Most Wanted Adaptations</h1>
      <p class="lede">
        The books readers most want to see on screen. One vote per person —
        {authed ? ' make yours count.' : ' log in to add yours.'}
      </p>
      {items.length === 0 ? (
        <p class="empty">No votes yet. Be the first to champion a book.</p>
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

const SHELF_ORDER = ['want_to_read', 'want_to_watch', 'done'] as const;

export function ShelvesPage({
  shelves,
  user,
}: {
  shelves: {
    targetType: 'book' | 'adaptation';
    targetId: number;
    title: string;
    shelf: string;
  }[];
  user: { email: string };
}) {
  const grouped = new Map<string, typeof shelves>();
  for (const s of shelves) {
    const arr = grouped.get(s.shelf) ?? [];
    arr.push(s);
    grouped.set(s.shelf, arr);
  }
  const ordered = [...SHELF_ORDER.filter((s) => grouped.has(s)), ...[...grouped.keys()].filter((k) => !(SHELF_ORDER as readonly string[]).includes(k))];
  return (
    <Layout title="My shelves" user={user}>
      <p class="kicker">Your collection</p>
      <h1 class="display-title">Shelves</h1>
      <p class="lede">Everything you've shelved — want to read, want to watch, and done.</p>
      {shelves.length === 0 ? (
        <p class="empty">
          Your shelves are empty. Browse <a href="/">adaptations</a> and shelve something.
        </p>
      ) : (
        ordered.map((shelf) => (
          <section class="shelf-group" key={shelf}>
            <h2>
              {shelfLabel(shelf)} <span class="count">({grouped.get(shelf)?.length ?? 0})</span>
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

export function LoginPage({ error }: { error?: string }) {
  return (
    <Layout title="Log in">
      <div class="auth-card">
        <p class="kicker">Welcome back</p>
        <h1>Log in</h1>
        <p>Enter your email and we'll send you a magic sign-in link. No passwords, ever.</p>
        {error && <div class="auth-error">{error}</div>}
        <form action="/auth/login" method="post">
          <label for="email">Email address</label>
          <input type="email" id="email" name="email" required autocomplete="email" placeholder="you@example.com" />
          <button class="btn btn-primary" type="submit">Send magic link</button>
        </form>
      </div>
    </Layout>
  );
}

export function MagicLinkSentPage({ email, devLink }: { email: string; devLink?: string }) {
  return (
    <Layout title="Check your email">
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

export function AuthErrorPage({ message }: { message: string }) {
  return (
    <Layout title="Sign-in problem">
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
const PROMOTE_STATUSES = [
  'rumored',
  'optioned',
  'in_development',
  'filming',
  'post_production',
  'released',
  'cancelled',
];

/**
 * QUEUE_SCRIPT — interaction contract (unchanged behavior):
 *  - buttons with [data-act] POST JSON to their data-path with
 *    X-Curation-Key taken from ?key= (plus optional { reason } from the
 *    enclosing form), then reload the page;
 *  - forms.promote-form POST { adaptation_id, status?, corroborating_url? }
 *    on submit, then reload.
 */
const QUEUE_SCRIPT = `
const KEY = new URLSearchParams(location.search).get('key') || '';
async function callApi(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Curation-Key': KEY },
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
  keyParam,
}: {
  status: NewsStatus;
  items: NewsItem[];
  sources: SourceRow[];
  counts: Record<NewsStatus, number>;
  keyParam: string;
}) {
  const withKey = (href: string) =>
    keyParam ? `${href}${href.includes('?') ? '&' : '?'}key=${encodeURIComponent(keyParam)}` : href;
  return (
    <Layout title="News curation">
      <p class="kicker">Owner console</p>
      <h1 class="display-title">News curation</h1>
      <p class="lede">
        The news pipeline proposes; you dispose. Sorted by trust tier, then
        confidence. <a href={withKey('/admin/news/runs')}>View pipeline runs →</a>
      </p>
      <nav class="tabs" aria-label="Queue status">
        {QUEUE_STATUSES.map((s) => (
          <a href={withKey(`/admin/news?status=${s}`)} class={s === status ? 'active' : ''} key={s}>
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
              <a href={item.url} rel="noopener noreferrer">
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
}: {
  runs: PipelineRun[];
  sources: SourceRow[];
}) {
  return (
    <Layout title="Pipeline runs">
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
