// public/js/utils.js — tiny shared helpers: XSS-safe HTML escaping, labels,
// poster art, and small view-model utilities. No dependencies.

/** Escape a value for safe interpolation into HTML text or attribute values. */
export function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Only allow http(s) URLs (plus site-local paths) into href/src attributes.
 * Returns null for anything else (javascript:, data:, protocol-relative, …).
 */
export function safeUrl(u) {
  if (typeof u !== 'string') return null;
  const s = u.trim();
  if (/^https?:\/\//i.test(s)) return s;
  if (/^\/[^/\\]/.test(s) && !s.includes('://')) return s;
  return null;
}

/** Same pluralization the server used. */
export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

export function statusLabel(status) {
  return String(status ?? '').replace(/_/g, ' ');
}

export function kindLabel(kind) {
  return kind === 'film' ? 'Film' : 'Series';
}

export function tierLabel(tier) {
  return tier === 'rumor' ? 'Rumor' : tier;
}

export function shelfLabel(shelf) {
  switch (shelf) {
    case 'want_to_read': return 'Want to Read';
    case 'read': return 'Read';
    case 'want_to_watch': return 'Want to Watch';
    case 'watched': return 'Watched';
    default: return statusLabel(shelf);
  }
}

/** Deterministic hue from a string, for gradient placeholder art. */
export function hueFor(s) {
  let h = 0;
  const str = String(s ?? '');
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** Avatar initials from an email, e.g. admin@example.com → "AD". */
export function initialsFor(email) {
  const local = String(email ?? '').split('@')[0].trim();
  const parts = local.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  const initials =
    parts.length >= 2
      ? parts.slice(0, 2).map((p) => p[0]).join('')
      : (parts[0] ?? local).slice(0, 2);
  return (initials || 'N').toUpperCase().slice(0, 2);
}

/** Public display name for a reviewer — the email's local part, never the address. */
export function displayName(email) {
  return String(email ?? '').split('@')[0] || 'reader';
}

/**
 * Poster/cover art that can never show a broken <img>: a gradient
 * placeholder always renders underneath; a dead image URL removes itself
 * via onerror, revealing the gradient.
 *
 * opts.eager — for above-the-fold art (hero, first grid cards): skips
 * loading="lazy" so the image is eligible for LCP. Combine with
 * opts.fetchpriority ('high') to prioritize the single most important image.
 */
export function posterArt(src, title, subtitle, opts) {
  const hue = hueFor(title);
  const gradient = `linear-gradient(135deg, hsl(${hue}, 48%, 22%), hsl(${(hue + 50) % 360}, 55%, 10%) 70%)`;
  const clean = typeof src === 'string' && src.trim() ? src.trim() : null;
  const safeSrc = clean && safeUrl(clean) ? esc(clean) : null;
  const eager = !!(opts && opts.eager);
  const fp = opts && opts.fetchpriority === 'high' ? ' fetchpriority="high"' : '';
  const srcset = clean ? tmdbSrcset(clean) : null;
  const sizes = (opts && opts.sizes) || POSTER_SIZES;
  return (
    `<div class="poster">` +
      `<div class="art-fallback" style="background:${gradient}">` +
        `<div class="art-mono" aria-hidden="true">${esc(String(title ?? '').charAt(0))}</div>` +
        `<div class="art-title">${esc(title)}</div>` +
        (subtitle ? `<div class="art-sub">${esc(subtitle)}</div>` : '') +
      `</div>` +
      (safeSrc
        ? `<img src="${safeSrc}"` +
          (srcset ? ` srcset="${esc(srcset)}" sizes="${esc(sizes)}"` : '') +
          ` alt="${esc(title)} artwork"${eager ? fp : ' loading="lazy"'} decoding="async" onerror="this.remove()">`
        : '') +
    `</div>`
  );
}

/**
 * Responsive srcset for TMDB image URLs (`https://image.tmdb.org/t/p/w500/…`):
 * rebuilds the same path at smaller TMDB widths so phones don't download the
 * full-size file. Returns null for non-TMDB sources (book covers etc.),
 * where no smaller variants exist. Deferred in the mobile plan until the
 * TMDB backfill populated real poster URLs — those now exist.
 */
const TMDB_IMG = /^https:\/\/image\.tmdb\.org\/t\/p\/(?:w\d+|original)(\/[^?#\s]+)$/;
const TMDB_SRCSET_WIDTHS = [185, 342, 500, 780];
export function tmdbSrcset(src) {
  const m = TMDB_IMG.exec(src);
  if (!m) return null;
  const path = m[1];
  return TMDB_SRCSET_WIDTHS.map(
    (w) => `https://image.tmdb.org/t/p/w${w}${path} ${w}w`,
  ).join(', ');
}
/** Default `sizes` for poster-grid cards: 2/3/4 columns by breakpoint. */
export const POSTER_SIZES = '(max-width:719px) 50vw, (max-width:959px) 33vw, 25vw';
/** `sizes` for the 300px-capped hero poster (`.hero .poster`). */
export const HERO_SIZES = '(max-width:819px) 100vw, 300px';

/** Year from a YYYY-MM-DD release_date, or null. */
export function releaseYear(releaseDate) {
  if (!releaseDate || releaseDate.length < 4) return null;
  const y = releaseDate.slice(0, 4);
  return /^\d{4}$/.test(y) ? y : null;
}

/** "2026-09-15 08:01:22" → "2026-09-15". */
export function dateOnly(ts) {
  return typeof ts === 'string' ? ts.slice(0, 10) : '—';
}

/** Debounce for the live search box. */
export function debounce(fn, ms) {
  let t = 0;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
