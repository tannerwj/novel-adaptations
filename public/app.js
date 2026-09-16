// public/app.js — SPA entry: theme, session, chrome, routes, router.

import { initTheme, loadSession } from './js/store.js';
import { mountChrome, refreshChrome } from './js/components.js';
import { registerRoutes, startRouter, onNavigated } from './js/router.js';
import { homeView, calendarView, mostWantedView, searchView } from './js/views/home.js';
import { adaptationView, bookView, watchView } from './js/views/detail.js';
import { myListsView, listDetailView, shelvesView } from './js/views/lists.js';
import { feedbackView } from './js/views/feedback.js';
import { loginView, verifyView } from './js/views/auth.js';
import {
  adminNewsView, adminRunsView, adminScreenWorksView, adminFeedbackView,
} from './js/views/admin.js';

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
  { pattern: /^\/lists\/?$/, view: myListsView, auth: true },
  { pattern: /^\/lists\/(?<slug>[^/]+)\/?$/, view: listDetailView },
  { pattern: /^\/shelves\/?$/, view: shelvesView, auth: true },
  { pattern: /^\/feedback\/?$/, view: feedbackView },
  { pattern: /^\/auth\/login\/?$/, view: loginView },
  { pattern: /^\/auth\/verify\/?$/, view: verifyView },
  { pattern: /^\/admin\/news\/?$/, view: adminNewsView, admin: true },
  { pattern: /^\/admin\/news\/runs\/?$/, view: adminRunsView, admin: true },
  { pattern: /^\/admin\/screen-works\/?$/, view: adminScreenWorksView, admin: true },
  { pattern: /^\/admin\/feedback\/?$/, view: adminFeedbackView, admin: true },
]);

startRouter();
