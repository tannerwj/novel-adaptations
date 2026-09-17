// src/theme.ts — theme cookie constant, shared by the API (v1.ts) and the
// SSR UI (ui.tsx). Kept in a .ts module so node unit tests can import the
// API router without pulling in the JSX UI bundle.
export const THEME_COOKIE = 'theme';
