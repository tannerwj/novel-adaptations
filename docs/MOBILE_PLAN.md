# Mobile-Friendliness Plan — Novel Adaptations

**Scope:** research + planning only. Audit of the live local app at `http://127.0.0.1:8787`
(Wrangler dev, commit `ebb8c57`) using headless Chromium with iPhone-class emulation at
**360×740** and **390×844** (iOS Safari UA, touch enabled, DPR 2).

**Coverage:** all 17 required views audited at both sizes, anonymous and (for gated views)
as a logged-in admin with seeded data (a 4-item list, shelf entries, 2 pending news items,
1 pipeline run, 2 feedback rows). 39 page loads total; screenshots in `/tmp/audit/shots/`
(research artifacts, not committed).

**Headline result:** no view has document-level horizontal overflow — the layout skeleton is
sound. The problems are (1) a desktop-first header that consumes ~250px of vertical space on
every page, (2) 20–44 sub-44px touch targets per page, (3) sub-16px form controls that trigger
iOS Safari auto-zoom on focus, (4) unstyled admin components, and (5) a cramped list-detail
reorder UI. Desktop at 1440px renders well and must not regress.

**Hard constraints for implementation:**
- Research/planning only — do not commit, push, or deploy; do not touch `/api/*`.
- Vanilla CSS/JS only; no new dependencies, no build step.
- Keep Fraunces/Inter, the light-default + dark-toggle token system, and the current visual
  identity — adapt, don't redesign.
- All mobile CSS must be scoped under `max-width` media queries so 1440px desktop is
  byte-for-byte unaffected. Verify with side-by-side 1440px screenshots before/after.

---

## 1. Navigation pattern decision

### Recommendation: bottom tab bar + slim top header (mobile ≤719px only)

**Mobile chrome (≤719px):**
- Top header collapses to one slim row: brand (left), search icon (expands inline search),
  theme toggle + avatar/Log-in (right). One row, ~56px tall.
- Bottom tab bar (fixed, 5 destinations): **Home · Calendar · Most Wanted · Search · More**.
  "More" opens a bottom sheet with: Lists, Shelves, Suggest a feature, Report an adaptation,
  Suggest a correction, Theme toggle, and (when applicable) Account / Admin links / Log out.
- The existing desktop header (brand + 5 links + search field + theme + login in one row) is
  untouched at ≥720px.

**Justification:**
- The current header wraps into **three rows (~250px, a third of a 740px viewport)** on
  every page — the single biggest mobile usability cost. A bottom bar + slim header returns
  ~190px of vertical space to content.
- The product is an interactive tracker (vote, rate, shelve, list, triage) — thumb-reach
  primary navigation fits its app-like usage better than a hamburger that buries navigation
  behind a tap.
- Keeps the five existing IA labels unchanged; "More" is a standard, discoverable overflow.
- Search stays one tap away in both patterns; making it a tab (not just a header icon)
  guarantees 44px+ targets without squeezing the top row.

**Alternative considered (hamburger):** brand + search icon + "Menu" button opening a panel.
Simpler markup and no safe-area work, but it hides the five primary destinations behind a
tap on every page and does less for one-handed use. Revisit only if user testing shows the
bottom bar conflicts with the editorial brand feel.

**Implementation notes for the bottom bar:**
- `position: fixed; bottom: 0` with `padding-bottom: env(safe-area-inset-bottom)`; add
  matching `padding-bottom` to `body`/main so the footer is never obscured.
- Active tab indicated with the existing `.active` pill treatment.
- The "More" sheet: `position: fixed` bottom sheet, scrim behind, Esc/backdrop-tap closes,
  focus moved into the sheet, `aria-expanded` on the trigger. Vanilla JS in `components.js`.
- **Server/client consistency:** the mobile chrome markup must be added byte-identically to
  `src/spa/chrome.ts` (`serverHeaderHtml`/`serverFooterHtml`) and `public/js/components.js`
  (`headerHtml`/`footerHtml`). See §8.

---

## 2. Global recommendations

### 2.1 Breakpoints
- Mobile/desktop boundary: **720px** (already used by footer + timeline; adopt everywhere).
- Keep existing min-width ramps: 640px (poster grid 3-col), 820px (hero 2-col), 900px
  (detail-grid 2-col), 960px (poster grid 4-col).
- All new mobile rules go in `@media (max-width: 719px) { … }` blocks appended near the
  related component in `public/styles.css`. Never restyle the base (desktop) rule to fix
  mobile — override it inside the query instead.

### 2.2 Type
- Minimum text size for information-carrying text: **12px**. Decorative kickers/badges at
  11–11.5px uppercase may stay (`.kicker`, `.kind-pill`, `.status-badge`, `.shelf-kind`,
  `.votes-label` — all currently 11.2–11.5px; acceptable as-is, do not shrink further).
- `h1`/`h2` scale: add a ≤719px step-down (e.g. `h1 { font-size: 2rem }`) — current
  `2.75rem` page titles dominate narrow screens (visible on Calendar, Most Wanted, Feedback).
- Never go below 16px on form controls (see §2.5).

### 2.3 Touch targets — 44×44px minimum
Applies to every **control** (links styled as buttons, buttons, selects, nav links, tabs,
icon buttons, poll/hype/star controls, pagination, admin action buttons, menu items).
Measured violations and fixes:

| Control (current size) | Fix |
|---|---|
| `.nav-link` 65–115×**36** | padding to 44px min-height in mobile header/tab bar |
| `.theme-toggle`, `.avatar-btn` **34×34** | 44×44 in slim mobile header |
| `.header-search input` 120×**31**, `.header-search .btn` **71×34** | mobile: search becomes icon → expanding field, or 44px-tall row |
| `.btn.btn-sm` (all) **×34** | mobile override: `min-height: 44px` (padding, not font change) |
| `.btn.btn-primary` (search/feedback/auth submit) **×41** | `min-height: 44px` globally (also benefits desktop) |
| `.vote-btn` 65–141×**41** | `min-height: 44px` |
| `.poll-btn` 151×**36** | `min-height: 44px`; stack full-width on ≤719px |
| `button.star` **23×22** | 44px hit area: keep 22px glyph, add padding (`width/height: 44px`, glyph centered). Enlarge gap on mobile. |
| `.hype-seg` (~**34** tall) | `min-height: 44px` |
| `.shelf-select` 151×**37** | `min-height: 44px` + 16px font |
| `a.back-link` 70×**24** | `min-height: 44px`, inline-flex align center |
| `.menu-item` (~**38** tall) | padding to 44px min-height |
| `.tab` (status filters) **×34** | `min-height: 44px` |
| Footer links (~16–20 tall) | footer already stacks; add `padding: .65rem 0` so each row ≥44px |
| List reorder `↑`/`↓` ghost buttons (~30px) | persistent 44×44 bordered buttons (see §4.9) |

Inline text links inside paragraphs (e.g. "The Movie Database" in the footer note,
"Suggest a correction") are exempt per WCAG 2.2 target-size inline exception — instead
ensure ≥8px vertical spacing between adjacent inline links and never place two tiny links
side-by-side without separation.

### 2.4 Viewport & safe areas
- Add to `public/styles.css` (and mirror critical bits in `src/spa/shell.ts`):
  ```css
  body { min-height: 100vh; min-height: 100dvh; }
  ```
  (keep `100vh` first as the fallback; `100dvh` fixes the mobile browser-chrome jump.
  Also use `100svh` where a stable small-viewport height is wanted, e.g. the More sheet
  max-height.)
- Bottom tab bar + More sheet: `padding-bottom: env(safe-area-inset-bottom)`; sheet
  `max-height: calc(90svh - env(safe-area-inset-bottom))`.
- Set `-webkit-tap-highlight-color: rgba(199,143,46,.25)` on interactive elements for
  visible touch feedback.
- `<meta name="viewport" content="width=device-width, initial-scale=1">` already present
  in `src/spa/shell.ts` — keep; do **not** add `maximum-scale=1` / `user-scalable=no`
  (accessibility).

### 2.5 Forms — kill the iOS auto-zoom
iOS Safari zooms the page when a focused control is <16px. Audit found these violations
(computed sizes, Chromium):

| Control | Current | Cause |
|---|---|---|
| `.header-search input[type=search]` | **13.6px** (`.85rem`) | explicit small size |
| Auth login email input | **13.6px** | `font: inherit` inside `label` (`.auth-card label` is `.85rem`) |
| Feedback form: type select, subject, body, proof_url, email | **13.6px** | `font: inherit` inside `.feedback-card label` (`.85rem`) |
| Lists create form: title, description (`.f-input`) | **13.6px** | `font: inherit` inside `.f-label` (`.85rem`) |
| List detail add-item: kind select, ID, note (`.f-input`) | **13.6px** | same |
| Review form: title, body (book/watch pages) | **13.6px** | `font: inherit` inside `.review-form label` (`.85rem`) |
| `.shelf-select` | **14.1px** (`.88rem`) | explicit small size |
| Admin `.actions input/select` | **13.6px** (`.85rem`) | explicit small size |

**Fix (one rule, global, mobile-first but safe to apply everywhere):**
```css
input, select, textarea { font-size: 16px; }
```
placed *after* the label rules, or scoped: `.auth-card input, .feedback-card input,
.feedback-card select, .feedback-card textarea, .f-label .f-input, .review-form input,
.review-form textarea, .shelf-select, .header-search input, .actions input, .actions select
{ font-size: 16px; }`. Do not change label text sizes — only the controls.
- `.auth-card` / `.feedback-card` padding is `2.5rem` — reduce to `1.25rem` at ≤719px.
- `.f-row` (list add-item form): at ≤719px make each `.f-label` full-width
  (`flex: 1 1 100%`) so fields stack deliberately instead of squeezing side-by-side.

### 2.6 Tables
One table exists: pipeline runs (`.admin-table` inside `.table-wrap`, admin only).
- ≤719px: **replace the table with labeled cards** (dl-style rows), not horizontal scroll.
  Card fields: Run # · Status · Feeds ok/failed · Fetched · New · Skipped · LLM calls ·
  Started · Error (only when present). This also fixes the current `undefined` rendering —
  see §4.14 adjacent bug: the client reads `trigger/processed/matched/queued/duration_ms`
  but the API returns `feeds_ok/feeds_failed/items_fetched/items_new/items_skipped_cap/
  llm_calls/errors`. The card layout must use the real field names.
- Keep `.table-wrap { overflow-x: auto }` as the desktop fallback; add
  `-webkit-overflow-scrolling: touch`.

### 2.7 Images
- Posters already lazy-load (`loading="lazy"`) except first-screen hero images (eager) —
  keep that split.
- Add `srcset`/`sizes` for poster `<img>`s when TMDB backfill populates real URLs
  (e.g. `w185`/`w342`/`w500`): `sizes="(max-width:719px) 50vw, (max-width:959px) 33vw, 25vw"`.
  Currently every poster downloads the full-size file on mobile.
- Fallback poster art (`.poster-fallback`): fine at card size; at ≤64px thumbs (calendar,
  shelf rows) the overlaid title text clips into illegible fragments ("an Ro", "Fo Wi").
  At thumb sizes render a single monogram letter instead of the full title block.

### 2.8 Grids & layout patterns
- Poster grid: 2 cols ≤639px, 3 cols ≥640px, 4 cols ≥960px — **keep**. Cards already wrap
  badges cleanly.
- Hero (`.hero`): 1 col <820px — **keep**.
- `.detail-grid.two`: 1 col <900px — **keep**.
- `.details-card` facts (fixed `8.5rem` label column): at ≤719px switch to stacked
  label-above-value (`grid-template-columns: 1fr`, label as small caps heading).
- Leaderboard `.rank-row` (`3.2rem 64px 1fr auto`): at ≤719px use a 2-row layout —
  row 1: rank + thumb + title/author; row 2: votes + full-width Vote button. Or keep one
  row but shrink thumb to 48px and move the vote button below via `grid-template-areas`.
- `.list-item` (list detail): at ≤719px make `.row-actions` `flex-basis: 100%`,
  `justify-content: flex-start`, with 44px reorder buttons (see §4.9).
- `.list-card` (lists index, admin work cards): at ≤719px stack `.row-actions` below the
  meta line, left-aligned, 44px buttons.

---

## 3. Severity scale

- **Critical** — blocks or badly degrades a core mobile task; fix in the first pass.
- **High** — violates platform conventions (44px targets, 16px inputs) or visibly broken UI
  on common flows.
- **Medium** — cramped, awkward, or inconsistent; degrades quality but task completable.
- **Low** — polish / future-proofing.

## 4. Per-view issue catalogue

All views measured at 360×740 and 390×844 (identical results at both sizes unless noted).
"Small targets" = interactive elements under 44×44px (automated count per page).

### 4.1 Home grid
- **High — header chrome.** Three wrapped rows (~250px tall): nav links 36px tall,
  search row 31–34px, theme 34×34 + Log in. Returns ~190px to content once the bottom
  tab bar + slim header (§1) lands.
- **High — search input 13.6px** (iOS zoom on focus); search button 71×34.
- **Medium — theme toggle 34×34**, Log in `a.btn.btn-sm` 65×34.
- **Low — kicker/badges 11.2–11.5px** (decorative; acceptable, don't shrink).
- Grid itself is good: 2-col cards, badges wrap, no overflow. Desktop 4-col must not change.

### 4.2 Adaptation detail
- **High — poll buttons** 151×36 (`.poll-btn`); stack full-width + 44px min-height on mobile.
- **High — header chrome** (same as Home).
- **Medium — timeline** already vertical on mobile; keep. `.step-meta` links 13px — bump to
  14px min at ≤719px or leave (inline exception applies).
- **Medium — `.details-card`** 8.5rem fixed label column; stack label-above-value ≤719px.
- **Medium — review-signin `a.btn.btn-sm`** ("Sign in to write a review") 34px tall.
- Low — poster fallback art fine; badges fine.

### 4.3 Book detail
- **High — star rating buttons 23×22px** (5 buttons). Fix: 44px hit area with centered
  22px glyph; widen gaps on mobile. (Logged-in state; anonymous sees static stars.)
- **High — review form inputs 13.6px** (title, body) → 16px. Submit `btn-sm` 34px → 44px.
- **High — `.shelf-select` 151×37, 14.1px** → 44px tall + 16px font.
- **Medium — "Add to list" select + Add button** row: select is fine at 16px? (verify
  computed size; same `.shelf-select`-style treatment).
- **Medium — "Suggest a correction"** inline link 20px tall; give it block spacing
  (it's a standalone line already — add `padding: .6rem 0`).
- Medium — `.details-card` stacking (same as 4.2).

### 4.4 Watch detail
- Same as 4.3 (stars, review form, shelf select, details-card).
- **High — hype segments** `.hype-seg` ~34px tall (CSS `padding: .55rem 0 .45rem`,
  `font-size: .85rem`) → `min-height: 44px`. Hype widget didn't render in the seeded audit
  (no data) — verify visually once a work has hype votes.
- Where-to-watch provider links: not present in seed data; when present, render as 44px
  list rows on mobile (recommendation; unverified visually).

### 4.5 Calendar
- **Medium — TBA row fallback thumbs (56px)** clip title text into fragments
  ("an Ro", "Fo Wi", "Mi Lib"). Use monogram letter at thumb size (§2.7).
- **Medium — kind pill** (SERIES/FILM) at trailing edge; with long titles the title column
  squeezes — allow pill to wrap below title at ≤719px (`flex-wrap` already on; make it
  deliberate: title `flex: 1 1 100%` when space is tight, or reduce thumb to 48px).
- Low — "Coming soon"/"Recently released" empty states fine; section spacing fine.

### 4.6 Most Wanted
- **High — Vote button** 65–141×41 → `min-height: 44px`.
- **Medium — `.rank-row` grid `3.2rem 64px 1fr auto`** cramps with long titles; switch to
  the 2-row mobile layout (§2.8). With the single seeded row it renders acceptably — the
  fix matters with real data (long book titles + author names).
- **Low — `.votes-label`** 11.2px uppercase (decorative; keep).

### 4.7 Search with results
- **High — search submit** `btn-primary` 278×41 → 44px min-height.
- **Medium — search form side-by-side** is fine, but at 360px the input is ~120px wide
  and placeholder text clips. At ≤719px: input `flex: 1`, keep side-by-side (it fits),
  or stack button below input full-width — recommend keeping side-by-side with
  `min-width: 0` on the input so typed text isn't squeezed.
- **Medium — result rows**: adaptation story links 26px tall; give story titles
  `padding: .5rem 0` and 44px row hit areas for the tap target.
- Low — "no results" empty state fine.

### 4.8 Lists index
- **High — create-form inputs 13.6px** (title `.f-input`, description textarea) → 16px.
- **High — "Create list"** `btn-primary` 103×41 → 44px.
- **Medium — list-card Edit/Delete** `btn-sm` 51–67×34; stack `.row-actions` below meta
  at ≤719px (§2.8).
- **Medium — public/private checkbox row** 13×13 native checkbox; wrap in a 44px-tall
  label row (label already clickable — add `min-height: 44px; align-items: center`).
- Low — card padding `2.5rem` on `.form-card` → `1.25rem` at ≤719px.

### 4.9 List detail (incl. reorder controls)
- **Critical — `.list-item` row crunch.** At 360px the pos + thumb + content + row-actions
  share one flex row; the reorder controls (↑ ↓ Remove) squeeze the content column to
  ~100px, wrapping titles/authors/notes into a jagged unreadable column
  (observed: "Dune / Book / . / Frank / Herbert" stacked). Fix at ≤719px: content block
  `flex: 1 1 100%` on its own row; `.row-actions` becomes a full-width action row below
  with persistent, bordered 44×44 reorder buttons (up/down), note-edit and Remove.
- **High — reorder buttons are ghost-styled `btn-ghost btn-sm`** (~30px, low contrast,
  de-emphasized until hover — hover doesn't exist on touch). Mobile: always-visible
  44×44 buttons with borders; keep ghost style only ≥720px.
- **High — add-item form inputs 13.6px** (kind select, ID number, note) → 16px;
  `.f-label` full-width stacking at ≤719px (§2.5).
- **Medium — "Copy link"** `btn-sm` 85×34 → 44px; share URL `code` wraps with
  `break-all` (fine) — stack label + code + button vertically at ≤719px.
- **Medium — "Edit title & description" / "Make private" / "Delete list"** `btn-sm`
  34px → 44px; allow wrap into two rows.
- **Medium — back-link** "← My lists" 70×24 → 44px min-height.
- Note: list title/description editing uses native `prompt()`/`confirm()` — functional on
  mobile; replacing with an inline editor is a UX improvement, out of scope for the CSS
  pass (listed as Low in §6).

### 4.10 Shelves
- Renders well: rows wrap, kind pill at trailing edge, section headers clear.
- **Medium — shelf title links** 40–200×20 → add `padding: .6rem 0` for 44px rows
  (rows are already full-width links; just enlarge the hit area).
- **Medium — long titles** ("The Fellowship of the Ring") wrap under the pill acceptably;
  formalize: title `flex: 1 1 12rem`, pill `flex: none`, so the pill never crushes text.
- Low — empty-shelf states fine.

### 4.11 Feedback
- **High — all form controls 13.6px** (type select, subject, body textarea, proof_url,
  email) → 16px. This is the worst iOS-zoom offender (5 controls).
- **High — submit** `btn-primary` 308×41 → 44px.
- **Medium — `.feedback-card` padding 2.5rem** → 1.25rem at ≤719px.
- **Medium — proof-URL hint text** 13px; keep ≥12px, fine.
- Low — type select options are short; no wrapping issues.

### 4.12 Login
- **High — email input 13.6px** → 16px (magic-link flow is the only auth; zooming here
  hits every new user).
- **High — "Send sign-in link"** `btn-primary` → 44px min-height.
- **Medium — `.auth-card` padding 2.5rem** → 1.25rem at ≤719px; the centered card is
  otherwise fine on mobile.
- Low — error/rate-limit messages render in-flow; keep.

### 4.13 Admin news queue
- **Critical — `.admin-bar` unstyled.** The admin sub-nav renders as raw blue inline text
  that breaks mid-word ("News queue⏱ Pipeline runs🎬 Screen works💬 Feedback" wraps as
  "Screen / works💬 Feedback"). Style it: horizontal scroll row or 2×2 grid of 44px tabs
  at ≤719px; consistent tab treatment at desktop.
- **High — `.news-review-card` unstyled** (no card border/padding; content runs full-width).
  Add the standard card treatment (border, radius, padding) — this is the missing-CSS fix
  that most improves admin on all sizes.
- **High — Approve/Promote/Dismiss buttons** `btn-sm` 34px → 44px.
- **Medium — status tabs** (Pending/Approved/Dismissed) wrap fine; make them 44px tall.
- Medium — long headlines wrap correctly once the card has padding; meta lines
  (`#1 · Variety · trust: …`) at 19px gray are fine.

### 4.14 Admin runs
- **Critical — `.admin-table` unstyled + clipped.** The table sits in `.table-wrap`
  (horizontal scroll) with no cell padding/borders; headers ("Proc/Match/Queue") clip
  mid-word at 360px. Fix: card layout at ≤719px (§2.6) + base table styling at desktop.
- **High — data-shape bug (adjacent, functional):** cells render
  `undefined/undefined/undefined` and Trigger is empty because the client reads
  `trigger/processed/matched/queued/duration_ms` but `/api/v1/admin/news/runs` returns
  `feeds_ok/feeds_failed/items_fetched/items_new/items_skipped_cap/llm_calls/errors`.
  The mobile card layout must use the real field names; fixing the mapping is a client-JS
  change (no API change needed).
- **Medium — "Run backfill (25 works)"** `btn-primary` 191×41 → 44px; the backfill panel
  card is otherwise mobile-fine.
- Low — empty-runs state ("No runs yet") fine.

### 4.15 Admin screen works
- Best of the admin views: already card-based (`.list-card` reuse), stacks cleanly.
- **High — Save/Clear** `btn-sm` 58–61×34 → 44px.
- **Medium — date input** is 16px (correct — it's a sibling of the label, not wrapped) —
  no change; keep `max-width: 11rem`.
- **Medium — `button.link` "Clear"** styled as plain text; on mobile give it the same
  44px bordered button treatment as Save (or keep text-button but 44px hit area).
- **Medium — work title links** 108–251×21 → `padding: .5rem 0` for larger hit areas.
- Low — unstyled `.admin-bar` (same fix as 4.13).

### 4.16 Admin feedback triage
- **High — `.feedback-row` unstyled** (plain text blocks, no separation). Add card
  treatment like the news queue.
- **High — "Mark reviewed" / "Mark done"** `btn-sm` 34px → 44px.
- **Medium — filter tabs** (All/New/Reviewed/Done) 44×34 → 44px tall; they wrap to two
  rows at 360px, which is acceptable, or horizontal-scroll them.
- **Medium — proof URL** long links: `break-all` already? verify — add
  `overflow-wrap: anywhere` to `.feedback-row a`.
- Low — unstyled `.admin-bar` (same fix as 4.13).

### 4.17 404
- Renders fine (centered message + home link). Only the global chrome issues apply
  (header size, link targets).
- **Medium — "Back to home" link** small → make it a 44px `.btn`.

## 5. Implementation checklists

### 5.1 Global CSS pass (do first — fixes every view)
- [ ] Add `@media (max-width: 719px)` mobile layer in `public/styles.css`
      (append per-component, near the component's base rules).
- [ ] 16px form-control rule (§2.5) — covers header search, auth, feedback, `.f-input`
      forms, review form, `.shelf-select`, `.actions` controls.
- [ ] 44px target sweep: `.btn-sm`, `.btn-primary`, `.vote-btn`, `.poll-btn`, `.tab`,
      `.back-link`, `.menu-item`, `.hype-seg`, `.shelf-select`, footer links (§2.3).
- [ ] Star buttons: 44px hit area, centered glyph (§2.3).
- [ ] `100dvh` fallback + `env(safe-area-inset-*)` on fixed chrome + tap-highlight (§2.4).
- [ ] `h1`/`h2` step-down at ≤719px; `.auth-card`/`.feedback-card`/`.form-card` padding
      `2.5rem` → `1.25rem` at ≤719px.
- [ ] Mirror the above-the-fold mobile rules into the critical CSS in `src/spa/shell.ts`
      (see §7).

### 5.2 Navigation (bottom tab bar + slim header)
- [ ] Mobile header markup (≤719px): one row — brand, search icon (expandable field),
      theme toggle, avatar/Log in. Hide the 5-link nav row and inline search field.
- [ ] Bottom tab bar: Home, Calendar, Most Wanted, Search, More (fixed, safe-area padded,
      active-pill state, 44px+ targets).
- [ ] "More" bottom sheet: Lists, Shelves, feedback links, theme toggle, account/admin
      links, Log in/out. Scrim, Esc/backdrop close, focus management, `aria-expanded`.
- [ ] Desktop ≥720px markup/CSS byte-identical to today.
- [ ] Byte-identical markup in `src/spa/chrome.ts` and `public/js/components.js` (§7).
- [ ] Body bottom padding so the fixed bar never covers the footer.

### 5.3 Per-view checklist
- [ ] **Home:** nav work only; verify 2-col grid + badges unchanged.
- [ ] **Adaptation detail:** poll buttons full-width 44px; details-card stacking;
      review-signin button 44px.
- [ ] **Book/Watch detail:** stars 44px hit areas; review form 16px + 44px submit;
      shelf-select 44px/16px; hype-seg 44px; details-card stacking.
- [ ] **Calendar:** monogram fallback thumbs ≤64px; pill wrap rule.
- [ ] **Most Wanted:** rank-row 2-row mobile layout; vote button 44px.
- [ ] **Search:** submit 44px; input `min-width: 0`; result rows 44px hit areas.
- [ ] **Lists index:** form 16px; Create 44px; row-actions stack; checkbox row 44px.
- [ ] **List detail:** row-actions full-width action row; persistent bordered 44px
      reorder buttons; add-item form 16px + stacked; share box stacked; list-action
      buttons 44px; back-link 44px.
- [ ] **Shelves:** title rows 44px hit area; title/pill flex rule.
- [ ] **Feedback:** all controls 16px; submit 44px; card padding.
- [ ] **Login:** email 16px; submit 44px; card padding.
- [ ] **Admin news queue:** style `.admin-bar` (44px tabs); card treatment for
      `.news-review-card`; action buttons 44px; status tabs 44px.
- [ ] **Admin runs:** labeled-card layout ≤719px using the **real** API field names
      (fix `undefined` mapping in client JS); base table styling ≥720px; backfill
      button 44px.
- [ ] **Admin screen works:** Save/Clear 44px; Clear as 44px button; title links hit area.
- [ ] **Admin feedback triage:** card treatment for `.feedback-row`; triage buttons 44px;
      filter tabs 44px; `overflow-wrap: anywhere` on proof links.
- [ ] **404:** "Back to home" as 44px button.

### 5.4 Images & performance
- [ ] Add `srcset`/`sizes` to poster `<img>`s once TMDB URLs exist
      (`sizes="(max-width:719px) 50vw, (max-width:959px) 33vw, 25vw"`).
- [ ] Monogram fallback for ≤64px thumbs.

---

## 6. Backlog (deliberately out of the CSS pass)

- **Low — `prompt()`/`confirm()`** for list rename/delete: functional on mobile, awkward.
  A future inline editor would be nicer; no API change needed (endpoints exist).
- **Low — inline-link spacing:** audit footer/content for adjacent tiny links; add spacing.
- **Low — `.hype-hint`** 12.8px (`.8rem`) — informational; bump to 13px+ if touched.
- **Low — review pagination** ("Load more reviews") `btn-sm` — covered by the global
  `.btn-sm` 44px sweep.

---

## 7. Server/client chrome consistency requirements

The shell has an explicit contract (stated in `src/spa/shell.ts`): for matching inputs,
`serverHeaderHtml()`/`serverFooterHtml()` in `src/spa/chrome.ts` and `headerHtml()`/
`footerHtml()` in `public/js/components.js` must be **byte-identical**. Any mobile chrome
work must honor this:

1. **Edit both files together.** Every markup change to the header/footer (slim mobile
   header, bottom tab bar, More sheet, mobile menu items) is made in `src/spa/chrome.ts`
   AND `public/js/components.js` with identical output. Diff the rendered HTML of a
   server response vs. the client render for `/`, `/calendar`, and `/admin/news` (logged
   in) at 360px and 390px to prove it.
2. **Critical CSS sync.** `src/spa/shell.ts` inlines critical above-the-fold CSS. The
   mobile header/tab-bar/sheet base styles (layout, safe-area, 44px targets) belong in
   that critical block as well as in `public/styles.css`; keep the two copies in sync.
3. **Active-state parity.** The server renders `.active` from the request path; the client
   router must compute the same active tab for all five tabs + More-sheet items
   (including `/adaptations/:id`, `/books/:id`, `/watch/:id` → no tab active, and
   `/lists/:slug` → Lists highlighted in the More sheet).
4. **No API changes.** `/api/*` is untouched — this whole plan is CSS + client markup/JS.
5. **Theme parity.** The bottom bar, sheet, and slim header must use the existing CSS
   variables (`--surface`, `--text`, `--border`, `--accent`, …) so light/dark toggle
   works with zero extra code. Test both themes at both widths.

---

## 8. Desktop regression guardrails (1440px must not regress)

- Every mobile rule lives inside `@media (max-width: 719px)`. No base-rule restyling.
- Baseline screenshots at 1440px exist (`/tmp/audit/shots/desktop-1440-home.png`); re-take
  after the pass and diff visually for: home, adaptation detail, book detail, calendar,
  most-wanted, search, lists index, admin news queue, admin runs.
- Specific risks to check: the 16px input rule must not enlarge desktop inputs in a way
  that breaks layouts (it only raises font-size — verify `.header-search` width and
  `.f-row` alignment); the 44px `.btn-sm` override is mobile-only so desktop buttons keep
  their current 34px height; the leaderboard 2-row layout is mobile-only.

---

## 9. Adjacent findings (not mobile, recorded during the audit)

1. **Admin runs data-shape mismatch (functional bug):** `runRowHtml` in
   `public/js/views/admin.js` reads `trigger/processed/matched/queued/duration_ms` but
   `GET /api/v1/admin/news/runs` returns `feeds_ok/feeds_failed/items_fetched/items_new/
   items_skipped_cap/llm_calls/errors`. Result: Trigger column empty,
   `undefined/undefined/undefined` in Proc/Match/Queue on desktop too. Fix the client
   mapping (no API change) — required before the §4.14 card layout.
2. **Admin components missing styles:** `.admin-bar`, `.news-review-card`,
   `.admin-table`, `.feedback-row`, `.auth-success` have no rules in `public/styles.css`
   (referenced only in `public/js/views/admin.js`). The §4.13–4.16 card/tab styling fixes
   this for all viewports.
3. **Shelf label inconsistency:** `public/js/views/lists.js` maps `want_to_read` →
   "Reading" while `public/js/utils.js` `shelfLabel()` returns "Want to Read". Pick one.

---

## 10. Verification protocol

Repeat the audit after implementation (same harness pattern: headless Chromium, iPhone UA,
touch, DPR 2, full-page scroll + screenshot):

- [ ] 360×740 and 390×844, all 17 views, anonymous + logged-in admin with seeded data.
- [ ] Zero document-level horizontal overflow on every page.
- [ ] Zero interactive elements under 44×44px (excluding paragraph-inline links).
- [ ] Zero form controls under 16px computed font-size.
- [ ] iOS Safari spot-check (real device or Simulator): focus each form control, confirm
      no auto-zoom; tap every primary control, confirm no mis-taps.
- [ ] Bottom tab bar: all 5 tabs + More sheet navigate correctly; sheet closes on
      scrim/Esc; active states match server render.
- [ ] 1440px screenshot diff: no visual change vs. baseline on 9 key views.
- [ ] Light + dark theme at 360px: no unreadable text in new chrome.
- [ ] `git status` shows only intended files; nothing committed/pushed/deployed by the
      implementer without explicit approval.

---

*Audit evidence: 39 page loads, 40+ screenshots (32 anonymous + 14 logged-in at two sizes + desktop baseline + widget close-ups) captured 2026-09-16 against local Wrangler dev at commit `ebb8c57`. Severity counts from the catalogue (§4 + §6 backlog): **Critical 3, High 24, Medium 29, Low 6** — counted per view occurrence; the implementation checklists in §5 deduplicate them into ~35 concrete fixes.*
