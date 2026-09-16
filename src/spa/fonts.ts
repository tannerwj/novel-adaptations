/**
 * Self-hosted font @font-face rules (latin subsets of Fraunces + Inter).
 *
 * The woff2 files live in public/fonts/ and are byte-identical to the latin
 * subsets previously served by Google Fonts. Same-origin serving removes the
 * render-blocking fonts.googleapis.com stylesheet; font-display: swap keeps
 * the previous non-blocking text behavior, and the visual result is
 * unchanged.
 *
 * Used by the SPA shell (src/spa/shell.ts, via /styles.css) and by the
 * legacy SSR Layout (src/ui.tsx, inlined).
 */
export const FONT_FACE_CSS = `@font-face {
  font-family: 'Fraunces';
  font-style: normal;
  font-weight: 500 700;
  font-display: swap;
  src: url('/fonts/fraunces-latin.woff2') format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 400 700;
  font-display: swap;
  src: url('/fonts/inter-latin.woff2') format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
`;
