// public/app.js — SPA entry: theme, session, chrome, routes, router.

import { initTheme, loadSession } from './js/store.js';
import { mountChrome, refreshChrome } from './js/components.js';
import { registerRoutes, startRouter, onNavigated } from './js/router.js';
import { homeView, calendarView, mostWantedView, searchView } from './js/views/home.js';
import { adaptationView, bookView, watchView } from './js/views/detail.js';

/**
 * Route-level code splitting: views below are fetched on demand the first
 * time their route is visited, keeping the initial module graph (and its
 * parse/compile cost) limited to the public browsing views. The router
 * already awaits promise-returning views, so a loader is just a function
 * that imports the module and delegates.
 */
const lazyView = (path, exportName) => (ctx) => import(path).then((m) => m[exportName](ctx));

// Theme is pre-painted by the inline shell script; initTheme mirrors it into the store.
initTheme();
// Session must resolve before the first render so auth-gated routes don't bounce.
await loadSession();
mountChrome();
onNavigated(() => refreshChrome());

registerRoutes([
  { pattern: /^\/?$/, view: homeView },
  { pattern: /^\/calendar\/?$/, view: calendarView },
  { pattern: /^\/most-wanted\/?$/, view: mostWantedView },
  { pattern: /^\/search\/?$/, view: searchView },
  { pattern: /^\/watch\/(?<id>\d+)\/?$/, view: watchView },
  { pattern: /^\/adaptations\/(?<id>\d+)\/?$/, view: adaptationView },
  { pattern: /^\/books\/(?<id>\d+)\/?$/, view: bookView },
  { pattern: /^\/lists\/?$/, view: lazyView('./js/views/lists.js', 'myListsView'), auth: true },
  { pattern: /^\/lists\/(?<slug>[^/]+)\/?$/, view: lazyView('./js/views/lists.js', 'listDetailView') },
  { pattern: /^\/shelves\/?$/, view: lazyView('./js/views/lists.js', 'shelvesView'), auth: true },
  { pattern: /^\/feedback\/?$/, view: lazyView('./js/views/feedback.js', 'feedbackView') },
  { pattern: /^\/privacy\/?$/, view: lazyView('./js/views/legal.js', 'privacyView') },
  { pattern: /^\/terms\/?$/, view: lazyView('./js/views/legal.js', 'termsView') },
  { pattern: /^\/auth\/login\/?$/, view: lazyView('./js/views/auth.js', 'loginView') },
  { pattern: /^\/auth\/verify\/?$/, view: lazyView('./js/views/auth.js', 'verifyView') },
  { pattern: /^\/admin\/news\/?$/, view: lazyView('./js/views/admin.js', 'adminNewsView'), admin: true },
  { pattern: /^\/admin\/news\/runs\/?$/, view: lazyView('./js/views/admin.js', 'adminRunsView'), admin: true },
  { pattern: /^\/admin\/screen-works\/?$/, view: lazyView('./js/views/admin.js', 'adminScreenWorksView'), admin: true },
  { pattern: /^\/admin\/feedback\/?$/, view: lazyView('./js/views/admin.js', 'adminFeedbackView'), admin: true },
]);

startRouter();

// Deterministic "SPA booted" signal: chrome wiring (header search, theme
// toggle, menus) and the router are attached by this point. E2E waits on
// this instead of racing module load + session fetch.
document.documentElement.dataset.spaBooted = 'true';
